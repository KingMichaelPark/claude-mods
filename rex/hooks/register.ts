import type { EngineInterface, Register } from "claude-code";

// Rex terminal integration for Claude Code. Two features, both active only
// when Claude runs in a Rex terminal.
//
// Approval pane. When Claude (or a sub-agent) wants to run a Bash command
// outside the sandbox and no allow rule covers it, a short-lived Rex pane
// opens below Claude's with the command in an editable prompt. Enter runs it
// there, as you, one time; Ctrl-O moves it into nvim first; Ctrl-C, closing
// the pane, or replacing the command with "# a reason" skips it. The mod reads
// the output with `rex capture`, closes the pane, and gives Claude the exit
// code and the output, or tells it plainly that you skipped the command.
// Nothing runs without your Enter.
//
// Agent tabs. Each sub-agent gets its own Rex tab in Claude's session: a live
// log of its prompt, its text, every tool call and result, and its final
// report. The agent still runs inside Claude Code; the tab only shows the
// work. A tab whose agent finishes cleanly closes itself after a countdown
// (press a key in it to keep it); a failed or interrupted agent's tab stays.

type On = Parameters<Register>[0];

// Store keys. Both features are on unless set to "off".
const APPROVE_KEY = "approve";
const TABS_KEY = "tabs";

// How long one `rex wait` runs before we look at next.signal again.
const WAIT_SLICE_S = 15;
// How long we wait for you before giving up on the pane.
const MAX_WAIT_MS = 60 * 60 * 1000;
// The most captured output handed to Claude (its tail is kept).
const MAX_OUTPUT_CHARS = 30_000;
// Seconds a finished agent's tab waits before it closes itself.
const AUTOCLOSE_S = 5;

type Rex = { session: string; block: string };

const isOn = async ($: EngineInterface, key: string) =>
    ((await $.store.get(key).catch(() => undefined)) as string | undefined) !==
    "off";

const rex = ($: EngineInterface, args: readonly string[], timeoutMs = 15_000) =>
    $.process.run(["rex", ...args], { timeoutMs });

const readFile = async ($: EngineInterface, path: string) =>
    (await $.fs.exists(path)) ? (await $.fs.read(path)).trim() : "";

const where = async ($: EngineInterface): Promise<Rex | undefined> => {
    const session = await $.env.get("REX_SESSION");
    const block = await $.env.get("REX_BLOCK");

    return session && block ? { session, block } : undefined;
};

const tempDir = async ($: EngineInterface, prefix: string) => {
    const made = await $.process.run(["mktemp", "-d", "-t", prefix]);
    const dir = made.stdout.trim();
    if (made.exitCode !== 0 || dir === "") throw new Error("mktemp failed");

    return dir;
};

const removeDir = ($: EngineInterface, dir: string) =>
    $.process.run(["rm", "-rf", dir]).catch(() => undefined);

// ------------------------------------------------------------- agent tabs

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

const outcomeLine = (tool: string, r: LooseResult, ms: number) => {
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
    const dir = await tempDir($, "rex-agent");
    await $.fs.write(`${dir}/title`, title);
    await $.fs.write(`${dir}/state`, "working");
    // Teammates go idle between turns rather than finishing, so never close.
    if (!teammate) await $.fs.write(`${dir}/autoclose`, String(AUTOCLOSE_S));
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
    const made = await rex($, [
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
    if (made.exitCode !== 0) {
        tabs.delete(agentId);
        await removeDir($, dir);
        throw new Error(made.stderr || "rex window new failed");
    }
    tab.windowId = (JSON.parse(made.stdout) as { window_id?: string }).window_id;

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
            if (!(await isOn($, TABS_KEY))) return res;
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
            outcomeLine(
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

// ----------------------------------------------------------- approval pane

type Outcome =
    | { kind: "skipped"; note: string }
    | { kind: "timeout" }
    | { kind: "interrupted" }
    | {
          kind: "ran";
          command: string;
          exitCode: string;
          output: string;
          stopped: boolean;
      };

// The text between the pane script's begin and end markers in a capture.
const sliceOutput = (screen: string, id: string) => {
    const begin = `⟦rex:${id}:begin⟧`;
    const end = `⟦rex:${id}:end⟧`;
    const from = screen.lastIndexOf(begin);
    const to = screen.lastIndexOf(end);
    if (from === -1) return "(output not found in the pane)";
    const body = screen
        .slice(from + begin.length, to > from ? to : undefined)
        .replace(/^\n/, "")
        .trimEnd();

    return body.length > MAX_OUTPUT_CHARS
        ? `[first ${body.length - MAX_OUTPUT_CHARS} characters left out]\n${body.slice(-MAX_OUTPUT_CHARS)}`
        : body;
};

// Waits until the pane script writes its status, the pane goes away, Claude's
// turn is interrupted, or we give up.
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
        const waited = await rex(
            $,
            ["wait", "-s", r.session, paneId, "--for", `${WAIT_SLICE_S}s`],
            (WAIT_SLICE_S + 15) * 1000,
        ).catch(() => undefined);
        if (await $.fs.exists(`${dir}/status`)) return "done";
        // You closed the pane ("block … closed", "… not found"), or `rex wait`
        // returned well before its slice ran out: the script is gone without
        // a status.
        if (
            /closed|not found/.test(waited?.stderr ?? "") ||
            (await $.clock.now()) - sliceStart < (WAIT_SLICE_S - 2) * 1000
        )
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
    // No status: you closed the pane. Whatever had started is not reported.
    if ((await readFile($, `${dir}/status`)) !== "ran")
        return { kind: "skipped", note: await readFile($, `${dir}/note`) };
    const cap = await rex($, [
        "capture",
        "-s",
        r.session,
        "-b",
        paneId,
        "--trim",
        "--unwrap",
    ]);

    return {
        kind: "ran",
        command: await readFile($, `${dir}/run.cmd`),
        exitCode: await readFile($, `${dir}/rc`),
        output:
            cap.exitCode === 0
                ? sliceOutput(cap.stdout, id)
                : "(the pane could not be captured)",
        stopped: await $.fs.exists(`${dir}/interrupted`),
    };
};

// The command inside a `rex split|run … -- COMMAND` call, or undefined.
const unwrapRex = async ($: EngineInterface, command: string) => {
    if (!/^\s*(\S*\/)?rex\s+(split|run)\b/.test(command)) return undefined;
    const out = await $.process
        .run(["/bin/zsh", "-f", `${$.plugin.root}/scripts/unwrap.zsh`, command])
        .catch(() => undefined);
    const inner = out?.exitCode === 0 ? out.stdout.replace(/\n$/, "") : "";

    return inner.trim() === "" ? undefined : inner;
};

const UNWRAPPED_NOTE =
    "Note: you wrapped this command in `rex split`/`rex run`. The Rex approval pane is already a split, so rex ran only the inner command there and opened no second pane. Next time call Bash with the command itself and `dangerouslyDisableSandbox: true`.";

const describe = (o: Outcome, proposed: string, unwrapped = false): string =>
    unwrapped
        ? `${describeOutcome(o, proposed)}\n\n${UNWRAPPED_NOTE}`
        : describeOutcome(o, proposed);

const describeOutcome = (o: Outcome, proposed: string): string => {
    switch (o.kind) {
        case "skipped":
            return [
                "SKIPPED BY THE USER. This command did not run. The user looked at it in the Rex approval pane and chose not to run it, because something about it is wrong.",
                o.note
                    ? `Their reason:\n${o.note}`
                    : "They gave no reason.",
                "Do not retry this command or a variant of it, and do not look for another route to the same effect. " +
                    (o.note
                        ? "Act on their reason; if it does not tell you what to do instead, ask them."
                        : "Ask the user what is wrong and what they want instead."),
            ].join("\n\n");
        case "timeout":
            return "The user did not act on the Rex approval pane within an hour; the command was not run.";
        case "interrupted":
            return "The turn was interrupted while the Rex approval pane was open; the command was not run.";
        case "ran": {
            const lines = [
                `The user approved this command and it ran in a Rex terminal pane, as the user, outside the sandbox. Exit code: ${o.exitCode || "unknown"}.`,
            ];
            if (o.command && o.command !== proposed.trim())
                lines.push(
                    `The user edited it first. The command that ran was:\n${o.command}`,
                );
            if (o.stopped)
                lines.push(
                    "The user pressed Ctrl-C while it ran, so the output may be incomplete.",
                );
            lines.push(`Output:\n${o.output || "(no output)"}`);

            return lines.join("\n\n");
        }
    }
};

// One approval pane at a time: calls that arrive together queue here.
let queue: Promise<unknown> = Promise.resolve();
const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const mine = queue.then(work, work);
    queue = mine.catch(() => undefined);

    return mine;
};

const GUIDANCE = {
    id: "rex:approval-pane",
    scope: "session",
    text: [
        "# Running commands outside the sandbox in this Rex terminal",
        "When a command has to run outside the sandbox, call Bash with that command itself and `dangerouslyDisableSandbox: true`. A Rex pane then opens for the user, who runs, edits or skips the command there. Its exit code and output come back as the tool result, and the pane closes by itself.",
        "Do not use `rex split`, `rex run`, `rex window new` or `rex send` to run such a command in a pane of your own and then `rex capture` to read it: every `rex` call is itself a command outside the sandbox, so the user would have to approve the run, the read and the close one by one. One Bash call does all three.",
        "Use `rex` directly only when the user asks for something to stay on screen (a tab, a split, a server, a monitor). Close any pane you opened and no longer need.",
        "If the result says the user skipped the command, do not retry it or a variant.",
    ].join("\n\n"),
} as const;

const HELP = [
    "Usage: /rex [status | on | off | agents on|off]",
    "  on|off         the approval pane: commands that leave the sandbox open in a Rex pane for you to run, edit or skip (default on; off uses the normal approval dialog)",
    "  agents on|off  a Rex tab for each sub-agent, to watch it work (default on)",
].join("\n");

const statusText = async ($: EngineInterface) =>
    [
        `rex approval pane: ${(await isOn($, APPROVE_KEY)) ? "on" : "off"}`,
        `rex agent tabs: ${(await isOn($, TABS_KEY)) ? "on" : "off"}`,
        ...((await where($)) ? [] : ["(not in a Rex terminal, so inactive)"]),
    ].join("\n");

export const register: Register = (on) => {
    registerAgentTabs(on);

    on("session.start", async ($, e, next) => {
        await $.command.register({
            name: "rex",
            description:
                "Rex approval pane for commands that leave the sandbox, and Rex tabs for sub-agents",
            argumentHint: "[status|on|off|agents on|off]",
        });

        return next(e);
    });

    // Without this, Claude leaves the sandbox by driving Rex by hand: it opens
    // its own pane for the command, then asks again to read it, and leaves it
    // open. Each of those `rex` calls needs its own approval.
    on("prompt.compose", async ($, e, next) => {
        const res = await next(e);
        if (!e.tools.includes("Bash")) return res;
        if ((await where($)) === undefined || !(await isOn($, APPROVE_KEY)))
            return res;

        return { sections: [...res.sections, GUIDANCE] };
    }).catch(($, e, next) => next(e));

    on("command.run", { command: "rex" }, async ($, e) => {
        const [what = "", value = ""] = e.args.trim().toLowerCase().split(/\s+/);
        if (what === "" || what === "status")
            return { text: `${await statusText($)}\n\n${HELP}` };
        if (what === "on" || what === "off") {
            await $.store.set(APPROVE_KEY, what);

            return { text: `rex approval pane ${what}.` };
        }
        if (what === "agents" && (value === "on" || value === "off")) {
            await $.store.set(TABS_KEY, value);

            return { text: `rex agent tabs ${value}.` };
        }

        return { text: HELP };
    });

    // Hooked at tool.call, before the permission prompt: an organisation's
    // security plugin can keep PermissionRequest from reaching mods.
    on("tool.call", { tool: "Bash" }, async ($, e, next) => {
        // Background commands keep the normal approval dialog.
        if (!e.dangerouslyDisableSandbox || e.run_in_background) return next(e);
        if (e.command.trim() === "") return next(e);
        if (!(await isOn($, APPROVE_KEY))) return next(e);
        const r = await where($);
        if (r === undefined) return next(e);
        // Calls your allow rules cover run directly; ones a rule denies are
        // refused as usual.
        const verdict = await $.tool.check({
            tool: "Bash",
            input: { command: e.command, dangerouslyDisableSandbox: true },
        });
        if (verdict.decision !== "ask") return next(e);
        // `rex split -- CMD` would open a second pane under the approval
        // pane: put CMD itself in the approval pane instead.
        const inner = await unwrapRex($, e.command);
        const command = inner ?? e.command;
        const unwrapped = inner !== undefined;

        const agentTab = e.agentId ? tabs.get(e.agentId) : undefined;
        if (agentTab)
            void emit(
                $,
                agentTab,
                yellow("  ⏸ waiting for you in the Rex approval pane"),
            );

        return inTurn(async () => {
            if (next.signal.aborted)
                return {
                    deny: describe({ kind: "interrupted" }, command, unwrapped),
                };

            // Set up the pane. Anything failing up to here falls back to the
            // normal dialog: nothing has run.
            let dir: string | undefined;
            let paneId: string;
            let id: string;
            try {
                dir = await tempDir($, "rex");
                id = dir.split("/").pop() ?? "x";
                await $.fs.write(`${dir}/command`, command);
                if (e.description)
                    await $.fs.write(`${dir}/description`, e.description);
                if (e.agentId)
                    await $.fs.write(`${dir}/who`, agentTab?.label ?? e.agentId);
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
                if (dir) await removeDir($, dir);
                $.ui.log(
                    `could not open a Rex pane, using the normal dialog: ${String(err)}`,
                    { to: "debug" },
                );

                return next(e);
            }

            // From here on the command may have run, so never fall back to next(e).
            $.ui.status("waiting for you in the approval pane");
            try {
                const waited = await waitForPane($, r, paneId, dir, next.signal);
                const outcome: Outcome =
                    waited === "done" || waited === "gone"
                        ? await readOutcome($, r, paneId, dir, id)
                        : { kind: waited };
                const text = describe(outcome, command, unwrapped);
                if (outcome.kind !== "ran") return { deny: text };

                return {
                    result: { stdout: text, stderr: "", interrupted: false },
                };
            } catch (err) {
                return {
                    deny: `rex lost track of the approval pane (${String(err)}), so it is not known whether the command ran. Ask the user what happened.`,
                };
            } finally {
                // The output is read by now: the pane has done its job.
                await rex($, ["block", "close", "-s", r.session, paneId]).catch(
                    () => undefined,
                );
                await removeDir($, dir);
                $.ui.status(undefined);
            }
        });
    }).catch(($, e, next) =>
        // Before next: nothing ran, so the normal approval path is safe. After it,
        // next(e) replays what it settled to and runs nothing twice.
        next(e),
    );
};
