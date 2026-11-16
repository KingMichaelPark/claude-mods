import type { EngineInterface, Register } from "claude-code";

// Rex terminal integration for Claude Code. Three features, all active only
// when Claude runs in a Rex terminal (the third is below, at registerBgTabs:
// a tab that follows each background command's output):
//
// Approvals. When a Bash call would stop for your approval, this mod opens a
// Rex pane below Claude's with the command prefilled instead. You read it,
// edit it if you like, and run it there yourself (or cancel). When the pane is
// done, you pick what Claude learns: the captured output, the exit code alone,
// or a summary you type. The output is only captured if you say so.
//
// Agent tabs. Each sub-agent Claude starts gets its own Rex tab in Claude's
// session: a live log of its prompt, its text, every tool call and result, and
// its final report. The tab's name and Rex status show whether it is working,
// finished or failed. The agent still runs inside Claude Code, so results,
// SendMessage and model routing work as before; the tab only shows the work.
// A tab whose agent finishes cleanly closes itself after a short countdown
// (press a key in it to keep it); a failed or interrupted agent's tab stays.

type On = Parameters<Register>[0];

type Mode = "ask" | "unsandboxed" | "off";
const MODES: readonly Mode[] = ["ask", "unsandboxed", "off"];
const MODE_KEY = "approve.mode";
const TABS_KEY = "tabs";
const AUTOCLOSE_KEY = "agents.autoclose";
// Seconds a finished agent's tab waits before it closes itself.
const AUTOCLOSE_S = 5;

// How long one `rex wait` runs before we look at next.signal again.
const WAIT_SLICE_S = 15;
// How long we wait for you before giving up on the pane.
const MAX_WAIT_MS = 60 * 60 * 1000;
// The most captured output handed to Claude (its tail is kept).
const MAX_OUTPUT_CHARS = 30_000;

type Rex = { session: string; block: string };
type Outcome =
    | { kind: "closed" }
    | { kind: "cancelled" }
    | { kind: "timeout" }
    | { kind: "interrupted" }
    | { kind: "ran"; runs: Run[]; share: string; summary: string };

type Run = { command: string; exitCode: string; output?: string };

const isMode = (s: string): s is Mode =>
    (MODES as readonly string[]).includes(s);

const getMode = async ($: EngineInterface): Promise<Mode> => {
    const raw = (await $.store.get(MODE_KEY).catch(() => undefined)) as
        | string
        | undefined;

    return raw !== undefined && isMode(raw) ? raw : "unsandboxed";
};

const showStatus = ($: EngineInterface, mode: Mode) =>
    $.ui.status(
        mode === "unsandboxed"
            ? undefined
            : mode === "off"
              ? "rex approve: off"
              : "rex approve: every approval",
    );

const rex = ($: EngineInterface, args: readonly string[], timeoutMs = 15_000) =>
    $.process.run(["rex", ...args], { timeoutMs });

const readFile = async ($: EngineInterface, path: string) =>
    (await $.fs.exists(path)) ? (await $.fs.read(path)).trim() : "";

const where = async ($: EngineInterface): Promise<Rex | undefined> => {
    const session = await $.env.get("REX_SESSION");
    const block = await $.env.get("REX_BLOCK");

    return session && block ? { session, block } : undefined;
};

// The text between the wrapper's begin and end markers for run `n` in a capture.
const sliceOutput = (screen: string, id: string, n: number, budget: number) => {
    const begin = `⟦rex:${id}:begin:${n}⟧`;
    const end = `⟦rex:${id}:end:${n}⟧`;
    const from = screen.lastIndexOf(begin);
    const to = screen.lastIndexOf(end);
    if (from === -1) return "(output not found in the pane)";
    const body = screen
        .slice(from + begin.length, to > from ? to : undefined)
        .replace(/^\n/, "")
        .trimEnd();

    return body.length > budget
        ? `[first ${body.length - budget} characters left out]\n${body.slice(-budget)}`
        : body;
};

// Waits until the wrapper writes its status, the pane goes away, Claude's turn
// is interrupted, or we give up.
const waitForPane = async (
    $: EngineInterface,
    r: Rex,
    paneId: string,
    dir: string,
    signal: AbortSignal,
): Promise<"done" | "gone" | "timeout" | "interrupted"> => {
    const started = await $.clock.now();
    for (;;) {
        if (await $.fs.exists(`${dir}/status`)) return "done";
        if (signal.aborted) return "interrupted";
        if ((await $.clock.now()) - started > MAX_WAIT_MS) return "timeout";
        const sliceStart = await $.clock.now();
        await rex(
            $,
            ["wait", "-s", r.session, paneId, "--for", `${WAIT_SLICE_S}s`],
            (WAIT_SLICE_S + 15) * 1000,
        ).catch(() => undefined);
        if (await $.fs.exists(`${dir}/status`)) return "done";
        // `rex wait` returned well before its slice ran out: the wrapper exited
        // (or the pane was closed) without writing a status.
        if ((await $.clock.now()) - sliceStart < (WAIT_SLICE_S - 2) * 1000)
            return "gone";
    }
};

const readOutcome = async (
    $: EngineInterface,
    r: Rex,
    paneId: string,
    dir: string,
    id: string,
): Promise<Outcome> => {
    const status = await readFile($, `${dir}/status`);
    if (status === "cancelled") return { kind: "cancelled" };
    // A pane that ended after running something, before you chose what to
    // share, still ran it: report that, with the exit codes alone.
    const hasRun = await $.fs.exists(`${dir}/runs`);
    if (status !== "ran" && !hasRun) return { kind: "closed" };
    const share = status === "ran" ? await readFile($, `${dir}/share`) : "code";
    const count = Math.max(
        1,
        Number.parseInt(await readFile($, `${dir}/runs`), 10) || 1,
    );
    const runs: Run[] = [];
    for (let n = 1; n <= count; n++)
        runs.push({
            command: await readFile($, `${dir}/run.${n}.cmd`),
            exitCode: await readFile($, `${dir}/run.${n}.rc`),
        });
    // Only read the pane when you chose to share what it printed.
    if (share === "output") {
        const cap = await rex($, [
            "block",
            "capture",
            "-s",
            r.session,
            "-b",
            paneId,
            "--trim",
            "--unwrap",
        ]);
        const budget = Math.floor(MAX_OUTPUT_CHARS / runs.length);
        runs.forEach((run, i) => {
            run.output =
                cap.exitCode === 0
                    ? sliceOutput(cap.stdout, id, i + 1, budget)
                    : "(the pane could not be captured)";
        });
    }

    return {
        kind: "ran",
        runs,
        share,
        summary: await readFile($, `${dir}/summary`),
    };
};

const describe = (o: Outcome, proposed: string): string => {
    switch (o.kind) {
        case "cancelled":
            return "The user reviewed this command in a Rex terminal pane and chose not to run it.";
        case "closed":
            return "The user closed the Rex approval pane without running this command.";
        case "timeout":
            return "The user did not act on the Rex approval pane within an hour; the command was not run.";
        case "interrupted":
            return "The turn was interrupted while the Rex approval pane was open; the command was not run.";
        case "ran": {
            const [first, ...rest] = o.runs;
            const lines = [
                `The user ran this command themselves in a Rex terminal pane. Exit code: ${first?.exitCode || "unknown"}.`,
            ];
            if (first?.command && first.command !== proposed.trim())
                lines.push(
                    `They edited it first. The command they ran was:\n${first.command}`,
                );
            if (o.share === "output")
                lines.push(`Output:\n${first?.output || "(no output)"}`);
            if (rest.length > 0)
                lines.push(
                    `They then ran ${rest.length} follow-on command${rest.length > 1 ? "s" : ""} in the same pane:`,
                    ...rest.map(
                        (run, i) =>
                            `Follow-on ${i + 1}: ${run.command}\nExit code: ${run.exitCode || "unknown"}` +
                            (o.share === "output"
                                ? `\nOutput:\n${run.output || "(no output)"}`
                                : ""),
                    ),
                );
            if (o.share === "summary")
                lines.push(
                    o.summary
                        ? `They chose not to share the output. Their summary of the result:\n${o.summary}`
                        : "They chose not to share the output and left the summary empty.",
                );
            else if (o.share !== "output")
                lines.push(
                    "They chose not to share the output; only the exit codes are known.",
                );

            return lines.join("\n\n");
        }
    }
};

// ------------------------------------------------------------- agent tabs

const tabsOn = async ($: EngineInterface) =>
    ((await $.store.get(TABS_KEY).catch(() => undefined)) as
        | string
        | undefined) !== "off";

const autocloseOn = async ($: EngineInterface) =>
    ((await $.store.get(AUTOCLOSE_KEY).catch(() => undefined)) as
        | string
        | undefined) !== "off";

// The most of a prompt, a text or a report shown in a tab.
const MAX_BLOCK_CHARS = 8_000;
// The most of a tool call's input shown on its line.
const MAX_LINE_CHARS = 160;
// The most of an agent's description used as its tab's name.
const MAX_LABEL_CHARS = 28;

type AgentState = "working" | "idle" | "done" | "error" | "aborted";
const MARKS: Record<AgentState, string> = {
    working: "◐",
    idle: "◇",
    done: "✓",
    error: "✗",
    aborted: "■",
};

type AgentTab = {
    dir: string;
    session: string;
    windowId?: string;
    label: string;
    teammate: boolean;
    state: AgentState;
    // The number of the last event written; the viewer prints them in order.
    seq: number;
    // Set once the tab was closed (its viewer removes the directory).
    gone: boolean;
};

// The open tabs by agent id. Kept in the module: after a reload, agents
// already running carry on without one.
const tabs = new Map<string, AgentTab>();

const sgr = (code: string, s: string) => `\x1b[${code}m${s}\x1b[0m`;
const dim = (s: string) => sgr("2", s);
const bold = (s: string) => sgr("1", s);
const cyan = (s: string) => sgr("36", s);
const green = (s: string) => sgr("32", s);
const red = (s: string) => sgr("31", s);
const yellow = (s: string) => sgr("33", s);

const oneLine = (s: string, max = MAX_LINE_CHARS) => {
    const line = s.replace(/\s+/g, " ").trim();

    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const block = (s: string, max = MAX_BLOCK_CHARS) => {
    const body =
        s.length > max
            ? `${s.slice(0, max)}\n[${s.length - max} more characters left out]`
            : s;

    return body
        .trimEnd()
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n");
};

const seconds = (ms: number) =>
    ms < 60_000
        ? `${(ms / 1000).toFixed(1)}s`
        : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

const timeOfDay = (ms: number) => new Date(ms).toTimeString().slice(0, 8);

// Keys `tool.call`'s input carries beside the tool's own arguments.
const RESERVED = new Set(["tool", "tool_use_id", "agentId", "requestMeta"]);

// The part of a tool call's input worth a line in the log.
const summarise = (tool: string, input: Record<string, unknown>): string => {
    const pick = (...keys: string[]) =>
        keys
            .map((k) => input[k])
            .find((v): v is string => typeof v === "string" && v !== "");
    switch (tool) {
        case "Bash":
            return pick("command") ?? "";
        case "Read":
        case "Write":
        case "Edit":
        case "NotebookEdit":
            return pick("file_path", "notebook_path") ?? "";
        case "Grep": {
            const where = pick("path", "glob");

            return `${pick("pattern") ?? ""}${where ? `  in ${where}` : ""}`;
        }
        case "Glob":
            return pick("pattern") ?? "";
        case "WebFetch":
            return pick("url") ?? "";
        case "WebSearch":
            return pick("query") ?? "";
        case "Agent":
            return pick("description") ?? "";
        case "Skill":
            return pick("skill") ?? "";
        default: {
            const first = Object.entries(input).find(
                ([k, v]) => !RESERVED.has(k) && typeof v === "string",
            );

            return first ? `${first[0]}: ${String(first[1])}` : "";
        }
    }
};

// What `tool.call`'s next(e) resolves to, as far as the log needs it.
type LooseResult = { deny?: string; isError?: true; text?: string };

const outcome = (tool: string, r: LooseResult, ms: number) => {
    const took = dim(` · ${seconds(ms)}`);
    if (r.deny) return `  ${red("✗")} ${tool} denied: ${oneLine(r.deny)}${took}`;
    if (r.isError)
        return `  ${red("✗")} ${tool}: ${oneLine(r.text ?? "error")}${took}`;
    const lines = r.text ? r.text.split("\n").length : 0;

    return dim(`  ✓ ${tool} · ${lines} line${lines === 1 ? "" : "s"}`) + took;
};

// Writes one event for the tab's viewer. The number is taken before any await,
// so events keep the order they were raised in even when written in parallel.
const emit = async ($: EngineInterface, tab: AgentTab, text: string) => {
    if (tab.gone) return;
    const n = ++tab.seq;
    try {
        if (!(await $.fs.exists(tab.dir))) {
            tab.gone = true;

            return;
        }
        await $.fs.write(`${tab.dir}/${String(n).padStart(5, "0")}.ev`, text);
    } catch {
        tab.gone = true;
    }
};

const setState = async ($: EngineInterface, tab: AgentTab, state: AgentState) => {
    if (tab.gone || tab.state === state) return;
    tab.state = state;
    await $.fs.write(`${tab.dir}/state`, state).catch(() => {
        tab.gone = true;
    });
    if (tab.windowId && !tab.gone)
        await rex($, [
            "window",
            "rename",
            "-s",
            tab.session,
            tab.windowId,
            `${MARKS[state]} ${tab.label}`,
        ]).catch(() => undefined);
};

const openTab = async (
    $: EngineInterface,
    r: Rex,
    agentId: string,
    title: string,
    teammate: boolean,
): Promise<AgentTab> => {
    const made = await $.process.run(["mktemp", "-d", "-t", "rex-agent"]);
    const dir = made.stdout.trim();
    if (made.exitCode !== 0 || dir === "") throw new Error("mktemp failed");
    await $.fs.write(`${dir}/title`, title);
    await $.fs.write(`${dir}/state`, "working");
    // Teammates go idle between turns rather than finishing, so never close.
    if (!teammate && (await autocloseOn($)))
        await $.fs.write(`${dir}/autoclose`, String(AUTOCLOSE_S));
    const label = oneLine(title, MAX_LABEL_CHARS);
    const tab: AgentTab = {
        dir,
        session: r.session,
        label,
        teammate,
        state: "working",
        seq: 0,
        gone: false,
    };
    // Tracked before the tab opens: the agent is already running, and what it
    // does meanwhile waits in the directory for the viewer.
    tabs.set(agentId, tab);
    const made2 = await rex($, [
        "window",
        "new",
        "-s",
        r.session,
        `${MARKS.working} ${label}`,
        "--focus=false",
        "--json",
        "-c",
        await $.session.cwd(),
        "--",
        "/bin/zsh",
        `${$.plugin.root}/scripts/agent-view.zsh`,
        dir,
    ]);
    if (made2.exitCode !== 0) {
        tabs.delete(agentId);
        await $.process.run(["rm", "-rf", dir]).catch(() => undefined);
        throw new Error(made2.stderr || "rex window new failed");
    }
    tab.windowId = (JSON.parse(made2.stdout) as { window_id?: string })
        .window_id;

    return tab;
};

const registerAgentTabs = (on: On) => {
    on("agent.spawn", async ($, e, next) => {
        const res = await next(e);
        const agentId = "agentId" in res ? res.agentId : undefined;
        if (agentId === undefined) return res;
        try {
            const known = tabs.get(agentId);
            // A tab that closed itself (or that you closed) takes its
            // directory with it: a resumed agent then gets a new tab.
            if (known && !known.gone && !(await $.fs.exists(known.dir)))
                known.gone = true;
            if (e.resume && known && !known.gone) {
                void emit(
                    $,
                    known,
                    `\n${yellow("↩ Resumed")}${e.prompt ? `\n${block(e.prompt)}` : ""}\n`,
                );
                await setState($, known, "working");

                return res;
            }
            if (!(await tabsOn($))) return res;
            const r = await where($);
            if (r === undefined) return res;
            const title = e.name || e.description || e.subagentType;
            const tab = await openTab($, r, agentId, title, e.isTeammate === true);
            const facts = [
                e.subagentType,
                "model" in res ? res.model : undefined,
                e.background ? "background" : "foreground",
                e.isTeammate ? "teammate" : undefined,
                e.workflow ? `workflow agent ${e.workflow.agentIndex}` : undefined,
                timeOfDay(await $.clock.now()),
            ].filter(Boolean);
            void emit(
                $,
                tab,
                [
                    bold(cyan(`━━ ${title} `)),
                    dim(facts.join(" · ")),
                    "",
                    bold(e.resume ? "Resumed with" : "Prompt"),
                    dim(block(e.prompt || "(none)")),
                    "",
                ].join("\n"),
            );
        } catch (err) {
            $.ui.log(`could not open a Rex tab for the agent: ${String(err)}`, {
                to: "debug",
            });
        }

        return res;
    }).catch(($, e, next) => next(e)); // the tab is only a view: never block the agent

    // A teammate woken by a message starts a new turn in the same tab.
    on("turn.start", async ($, e, next) => {
        const tab = e.agentId ? tabs.get(e.agentId) : undefined;
        if (tab) await setState($, tab, "working");

        return next(e);
    });

    // The agent's text between tool calls. The last step's text is its report,
    // shown at turn.complete instead.
    on("turn.step", async function* ($, e, next) {
        const r = yield* next(e);
        const tab = e.agentId ? tabs.get(e.agentId) : undefined;
        if (tab && r && r.toolUses.length > 0 && r.answer.trim() !== "")
            void emit($, tab, `\n${r.answer.trim()}\n`);

        return r;
    });

    on("tool.call", async ($, e, next) => {
        const tab = e.agentId ? tabs.get(e.agentId) : undefined;
        if (tab === undefined || tab.gone) return next(e);
        const started = await $.clock.now();
        const what = oneLine(
            summarise(e.tool, e as unknown as Record<string, unknown>),
        );
        void emit($, tab, `${cyan("▸")} ${bold(e.tool)} ${what}`);
        const res = await next(e);
        void emit(
            $,
            tab,
            outcome(
                e.tool,
                res as unknown as LooseResult,
                (await $.clock.now()) - started,
            ),
        );

        return res;
    }).catch(($, e, next) => next(e)); // the tab is only a view: never block the agent

    on("turn.complete", async ($, e, next) => {
        const tab = e.agentId ? tabs.get(e.agentId) : undefined;
        if (tab === undefined || tab.gone) return next(e);
        const state: AgentState =
            e.reason === "answer"
                ? tab.teammate
                    ? "idle"
                    : "done"
                : e.reason === "aborted"
                  ? "aborted"
                  : "error";
        const heading =
            state === "done" || state === "idle"
                ? green(bold("✓ Report"))
                : state === "aborted"
                  ? yellow(bold("■ Interrupted"))
                  : red(bold(`✗ Ended: ${e.reason}`));
        const usage = e.usage
            ? ` · ${e.usage.input_tokens + e.usage.cache_read_input_tokens + e.usage.cache_creation_input_tokens} in / ${e.usage.output_tokens} out tokens`
            : "";
        // Awaited: the report must be written before the state that may
        // start the tab's close countdown.
        await emit(
            $,
            tab,
            [
                "",
                heading,
                block(e.answer || "(no text)"),
                "",
                dim(`${seconds(e.durationMs)}${usage}`),
                dim("─".repeat(40)),
            ].join("\n"),
        );
        await setState($, tab, state);

        return next(e);
    });
};

// ------------------------------------------------- background command tabs

// Each Bash command Claude runs in the background (or moves there with
// Ctrl+B or a timeout) gets a Rex tab that follows its output file. Claude
// Code still runs the command, in its sandbox: the tab only shows the output,
// and Ctrl-C in it can stop the command.

const BG_KEY = "bg";

const bgOn = async ($: EngineInterface) =>
    ((await $.store.get(BG_KEY).catch(() => undefined)) as
        | string
        | undefined) !== "off";

type BgTab = {
    dir: string;
    session: string;
    windowId?: string;
    label: string;
};

// The open tabs by background task id.
const bgTabs = new Map<string, BgTab>();

// What a Bash call's next(e) resolves to, as far as this needs it.
type LooseBash = {
    text?: string;
    result?: { backgroundTaskId?: string; backgroundOutputPath?: string };
};

const OUTPUT_PATH = /Output is being written to: (\S+?\.output)\b/;

const openBgTab = async (
    $: EngineInterface,
    r: Rex,
    taskId: string,
    output: string,
    command: string,
    title: string,
) => {
    const made = await $.process.run(["mktemp", "-d", "-t", "rex-bg"]);
    const dir = made.stdout.trim();
    if (made.exitCode !== 0 || dir === "") throw new Error("mktemp failed");
    await $.fs.write(`${dir}/output`, output);
    await $.fs.write(`${dir}/command`, command);
    await $.fs.write(`${dir}/title`, title);
    const label = oneLine(`$ ${title || command}`, MAX_LABEL_CHARS);
    const tab: BgTab = { dir, session: r.session, label };
    bgTabs.set(taskId, tab);
    const opened = await rex($, [
        "window",
        "new",
        "-s",
        r.session,
        `${MARKS.working} ${label}`,
        "--focus=false",
        "--json",
        "-c",
        await $.session.cwd(),
        "--",
        "/bin/zsh",
        `${$.plugin.root}/scripts/bg-view.zsh`,
        dir,
    ]);
    if (opened.exitCode !== 0) {
        bgTabs.delete(taskId);
        await $.process.run(["rm", "-rf", dir]).catch(() => undefined);
        throw new Error(opened.stderr || "rex window new failed");
    }
    tab.windowId = (JSON.parse(opened.stdout) as { window_id?: string })
        .window_id;
};

// Records a background task's end in its tab: the exit file for the viewer,
// and a mark on the tab's name.
const endBgTab = async (
    $: EngineInterface,
    taskId: string,
    status: string,
    code: string | undefined,
) => {
    const tab = bgTabs.get(taskId);
    if (tab === undefined) return;
    bgTabs.delete(taskId);
    if (!(await $.fs.exists(tab.dir))) return; // the tab was closed
    await $.fs.write(`${tab.dir}/exit`, code ? `${status} ${code}` : status);
    const mark =
        status === "completed" && (code === undefined || code === "0")
            ? MARKS.done
            : status === "completed" || status === "failed"
              ? MARKS.error
              : MARKS.aborted;
    if (tab.windowId)
        await rex($, [
            "window",
            "rename",
            "-s",
            tab.session,
            tab.windowId,
            `${mark} ${tab.label}`,
        ]).catch(() => undefined);
};

const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g;

// Marks the end of each tracked background task a notification text reports.
const endBgTabsFrom = async ($: EngineInterface, raw: string) => {
    if (bgTabs.size === 0 || !raw.includes("task-notification")) return;
    for (const [, body = ""] of raw.matchAll(NOTIFICATION)) {
        const id = /<task-id>([^<]+)<\/task-id>/.exec(body)?.[1];
        const status = /<status>([^<]+)<\/status>/.exec(body)?.[1];
        if (!id || !status || !bgTabs.has(id)) continue;
        const code = /exit code (\d+)/.exec(body)?.[1];
        await endBgTab($, id, status, code).catch(() => undefined);
    }
};

const registerBgTabs = (on: On) => {
    on("tool.call", { tool: "Bash" }, async ($, e, next) => {
        const res = await next(e);
        const loose = res as unknown as LooseBash;
        const taskId = loose.result?.backgroundTaskId;
        // A command kept on another machine has no output file here.
        if (!taskId || loose.result?.backgroundOutputPath) return res;
        try {
            const output = OUTPUT_PATH.exec(loose.text ?? "")?.[1];
            if (!output || !(await bgOn($))) return res;
            const r = await where($);
            if (r === undefined) return res;
            await openBgTab($, r, taskId, output, e.command, e.description ?? "");
        } catch (err) {
            $.ui.log(
                `could not open a Rex tab for the background command: ${String(err)}`,
                { to: "debug" },
            );
        }

        return res;
    }).catch(($, e, next) => next(e)); // the tab is only a view

    // A background task's end reaches the conversation as a notification,
    // which carries its status and exit code. It is submitted as a prompt
    // (origin task-notification), then appended to the session. Both are
    // hooked: an organisation's plugin can send session.append on past this
    // mod's hook. endBgTab forgets a task once handled, so it runs once.
    on("prompt.submit", async ($, e, next) => {
        if (e.origin.kind === "task-notification")
            await endBgTabsFrom($, e.text).catch(() => undefined);

        return next(e);
    }).catch(($, e, next) => next(e));

    on("session.append", async ($, e, next) => {
        if (bgTabs.size > 0)
            await endBgTabsFrom($, JSON.stringify(e.message.content));

        return next(e);
    }).catch(($, e, next) => next(e));
};

const HELP = [
    "Usage: /rex [status | agents <on|off> | autoclose <on|off> | bg <on|off> | approve <mode>]",
    "  agents on|off        a Rex tab for each sub-agent, to watch it work (default on)",
    `  autoclose on|off     close a sub-agent's tab ${AUTOCLOSE_S}s after it finishes cleanly (default on)`,
    "  bg on|off            a Rex tab for each background command, following its output (default on)",
    "  approve unsandboxed  commands that leave the sandbox and need approval open in a Rex pane (default)",
    "  approve ask          every Bash command that needs approval (not for auto mode)",
    "  approve off          use the normal approval dialog",
].join("\n");

const statusText = async ($: EngineInterface) => {
    const inRex = (await where($)) !== undefined;

    return [
        `rex agents: ${(await tabsOn($)) ? "on" : "off"}`,
        `rex autoclose: ${(await autocloseOn($)) ? "on" : "off"}`,
        `rex bg: ${(await bgOn($)) ? "on" : "off"}`,
        `rex approve: ${await getMode($)}`,
        ...(inRex ? [] : ["(not in a Rex terminal, so inactive)"]),
    ].join("\n");
};

export const register: Register = (on) => {
    registerAgentTabs(on);
    registerBgTabs(on);

    on("session.start", async ($, e, next) => {
        await $.command.register({
            name: "rex",
            description:
                "Rex tabs for sub-agents and background commands, and Rex approvals",
            argumentHint:
                "[status|agents on|off|autoclose on|off|bg on|off|approve <mode>]",
        });
        showStatus($, await getMode($));

        return next(e);
    });

    on("command.run", { command: "rex" }, async ($, e) => {
        const [what = "", value = ""] = e.args.trim().toLowerCase().split(/\s+/);
        if (what === "" || what === "status")
            return { text: `${await statusText($)}\n\n${HELP}` };
        if (what === "approve" && isMode(value)) {
            await $.store.set(MODE_KEY, value);
            showStatus($, value);

            return { text: `rex approve set to ${value}.` };
        }
        if (
            (what === "agents" || what === "bg" || what === "autoclose") &&
            (value === "on" || value === "off")
        ) {
            const key =
                what === "agents"
                    ? TABS_KEY
                    : what === "bg"
                      ? BG_KEY
                      : AUTOCLOSE_KEY;
            await $.store.set(key, value);

            return { text: `rex ${what} ${value}.` };
        }

        return { text: HELP };
    });

    // Hooked at tool.call, before the permission prompt: an organisation's
    // security plugin can keep PermissionRequest from reaching mods.
    on("tool.call", { tool: "Bash" }, async ($, e, next) => {
        if (e.run_in_background) return next(e);
        const command = e.command;
        if (command.trim() === "") return next(e);
        const mode = await getMode($);
        if (mode === "off") return next(e);
        if (mode === "unsandboxed" && !e.dangerouslyDisableSandbox)
            return next(e);
        const r = await where($);
        if (r === undefined) return next(e);
        // Calls your allow rules cover still run directly.
        const verdict = await $.tool.check({
            tool: "Bash",
            input: {
                command,
                dangerouslyDisableSandbox: e.dangerouslyDisableSandbox,
            },
        });
        if (verdict.decision !== "ask") return next(e);
        const input = { description: e.description };

        // Set up the pane. Anything failing up to here falls back to the normal dialog.
        let dir: string;
        let paneId: string;
        try {
            const made = await $.process.run([
                "mktemp",
                "-d",
                "-t",
                "rex",
            ]);
            dir = made.stdout.trim();
            if (made.exitCode !== 0 || dir === "")
                throw new Error("mktemp failed");
            await $.fs.write(`${dir}/command`, command);
            if (input.description)
                await $.fs.write(`${dir}/description`, input.description);
            const id = dir.split("/").pop() ?? "x";
            const split = await rex($, [
                "split",
                "-s",
                r.session,
                "-b",
                r.block,
                "--split=below",
                "--ratio",
                "40",
                "--label",
                "approve",
                "--keep-open",
                "--json",
                "-c",
                await $.session.cwd(),
                "--",
                "/bin/zsh",
                `${$.plugin.root}/scripts/approve.zsh`,
                dir,
                id,
            ]);
            const created = JSON.parse(split.stdout) as {
                block_ids?: string[];
            };
            if (split.exitCode !== 0 || !created.block_ids?.[0])
                throw new Error(split.stderr || "rex split failed");
            paneId = created.block_ids[0];
        } catch (err) {
            $.ui.log(
                `could not open a Rex pane, using the normal dialog: ${String(err)}`,
                { to: "debug" },
            );

            return next(e);
        }

        // From here on the command may have run, so never fall back to next(e).
        const id = dir.split("/").pop() ?? "x";
        $.ui.status("rex approve: waiting for you in the Rex pane");
        try {
            const waited = await waitForPane($, r, paneId, dir, next.signal);
            const outcome: Outcome =
                waited === "done" || waited === "gone"
                    ? await readOutcome($, r, paneId, dir, id)
                    : { kind: waited };
            const text = describe(outcome, command);
            if (outcome.kind !== "ran") return { deny: text };

            return { result: { stdout: text, stderr: "", interrupted: false } };
        } catch (err) {
            return {
                deny: `rex lost track of the approval pane (${String(err)}). Ask the user what happened.`,
            };
        } finally {
            showStatus($, await getMode($));
            await rex($, ["block", "close", "-s", r.session, paneId]).catch(
                () => undefined,
            );
            await $.process.run(["rm", "-rf", dir]).catch(() => undefined);
        }
    }).catch(($, e, next) =>
        // Before next: nothing ran, so the normal approval path is safe. After it,
        // next(e) replays what it settled to and runs nothing twice.
        next(e),
    );
};
