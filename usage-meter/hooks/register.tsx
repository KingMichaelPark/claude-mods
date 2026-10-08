import { atom, read, update } from "claude-code";
import type { EngineInterface, Register, SessionUsage } from "claude-code";

import { colour, meter } from "./format";

const current = atom({ plugin: "usage-meter", key: "meter" } as const, null);

// The size after a compaction, shown until the next response measures the real one.
let estimate: number | undefined;

const refresh = async (
    $: EngineInterface,
    usage?: Pick<SessionUsage, "context" | "cost">,
) => {
    const u = usage ?? (await $.session.usage());
    const context =
        estimate === undefined
            ? u.context
            : {
                ...u.context,
                tokens: estimate,
                percent: Math.round((estimate / u.context.window) * 100),
            };
    const next = meter(
        await $.session.model(),
        { ...u, context },
        estimate !== undefined,
    );
    await update($, current, () => next);
};

export const register: Register = (on) => {
    on("session.start", async ($, e, next) => {
        const result = await next(e);
        estimate = undefined;
        $.ui.status(undefined);
        await refresh($);
        return result;
    });

    on("session.measure", async ($, e, next) => {
        estimate = undefined;
        await refresh($, e);
        return next(e);
    });

    // /compact sends no response, so the last measured size is stale until the next one.
    on("session.compact", async ($, e, next) => {
        const result = await next(e);
        if (
            e.trigger === "precompute" ||
            result.skip !== undefined ||
            result.tokensAfter === undefined
        )
            return result;
        estimate = result.tokensAfter;
        try {
            await refresh($);
        } catch {
            $.ui.log("usage-meter: could not refresh after compaction", {
                to: "debug",
            });
        }
        return result;
    }).catch(($, e, next) => next(e));

    // A /model switch shows on the next prompt, before any response arrives.
    on("prompt.submit", async ($, e, next) => {
        await refresh($);
        return next(e);
    }).catch(($, e, next) => next(e));

    on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
        const m = await read($, current);
        if (e.props.hasSurvey || m === null) return next(e);

        const { Text } = $.ui.resolve(e);
        const c = colour(m.percent);

        return c ? (
            <Text color={c}>{m.text}</Text>
        ) : (
            <Text dimColor>{m.text}</Text>
        );
    });
};
