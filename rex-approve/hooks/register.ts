import type { EngineInterface, Register } from "claude-code";

// When a Bash call would stop for your approval, this mod opens a Rex pane
// below Claude's with the command prefilled instead. You read it, edit it if
// you like, and run it there yourself (or cancel). When the pane is done, you
// pick what Claude learns: the captured output, the exit code alone, or a
// summary you type. The output is only captured if you say so.

type Mode = "ask" | "unsandboxed" | "off";
const MODES: readonly Mode[] = ["ask", "unsandboxed", "off"];
const MODE_KEY = "mode";

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
              ? "rex-approve: off"
              : "rex-approve: every approval",
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
    const begin = `⟦rex-approve:${id}:begin:${n}⟧`;
    const end = `⟦rex-approve:${id}:end:${n}⟧`;
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

const HELP = [
    "Usage: /rex-approve [ask | unsandboxed | off | status]",
    "  unsandboxed  commands that leave the sandbox and need approval open in a Rex pane (default)",
    "  ask          every Bash command that needs approval (not for auto mode)",
    "  off          use the normal approval dialog",
].join("\n");

export const register: Register = (on) => {
    on("session.start", async ($, e, next) => {
        await $.command.register({
            name: "rex-approve",
            description:
                "Approve Bash commands by running them yourself in a Rex pane",
            argumentHint: "[ask|unsandboxed|off|status]",
        });
        showStatus($, await getMode($));

        return next(e);
    });

    on("command.run", { command: "rex-approve" }, async ($, e) => {
        const arg = e.args.trim().toLowerCase();
        const inRex = (await where($)) !== undefined;
        if (arg === "" || arg === "status")
            return {
                text: `rex-approve: ${await getMode($)}${inRex ? "" : " (not in a Rex terminal, so inactive)"}\n${HELP}`,
            };
        if (!isMode(arg)) return { text: HELP };
        await $.store.set(MODE_KEY, arg);
        showStatus($, arg);

        return { text: `rex-approve set to ${arg}.` };
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
                "rex-approve",
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
        $.ui.status("rex-approve: waiting for you in the Rex pane");
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
                deny: `rex-approve lost track of the approval pane (${String(err)}). Ask the user what happened.`,
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
