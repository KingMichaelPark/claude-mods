import type { SessionUsage, ThemeKey } from "claude-code";

import type { Meter } from "../types";

const compact = (n: number) =>
    n >= 1_000_000
        ? `${(n / 1_000_000).toFixed(1)}M`
        : n >= 1000
            ? `${Math.round(n / 1000)}k`
            : `${n}`;

const shortModel = (id: string) =>
    `󱜙  ${id}`
        .replace(/^claude-/, "")
        .replace(/-\d{8}$/, "")
        .replace(/\[1m\]$/, " 1M");

// `estimated` marks a size the engine has not measured yet, such as just after a compaction.
export const meter = (
    model: string,
    usage: Pick<SessionUsage, "context" | "cost">,
    estimated = false,
): Meter => {
    const { tokens, window, percent } = usage.context;
    const parts = [shortModel(model)];
    const mark = estimated ? "~" : "";
    parts.push(
        tokens === undefined
            ? `–/${compact(window)}`
            : `${mark}${compact(tokens)}/${compact(window)} (${mark}${percent ?? 0}%)`,
    );
    if (usage.cost) parts.push(`  ${usage.cost.usd.toFixed(2)}`);
    return {
        text: parts.join(" · "),
        percent: tokens === undefined ? -1 : (percent ?? 0),
    };
};

// Green below 40%, amber from 40% to below 70%, red from 70%; undefined before the first response.
export const colour = (percent: number): ThemeKey | undefined =>
    percent < 0
        ? undefined
        : percent < 40
            ? "success"
            : percent < 70
                ? "warning"
                : "error";
