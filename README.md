# Claude Mods

A curated collection of lightweight, high-impact plugins for **Claude Code** designed to give you real-time visibility
into session consumption and automatically optimize your token usage and API costs.

---

## 📦 Included Plugins

| Plugin                               | Description                                                                          | Key Highlight                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| [**`usage-meter`**](#-usage-meter)   | Real-time prompt header displaying model, context window capacity, and session cost. | Color-coded context fill alerts & instant post-compaction estimates.                                |
| [**`model-router`**](#-model-router) | Autonomous model routing for spawned sub-agents based on task complexity.            | Keeps the main thread on your preferred model while routing sub-tasks to the cheapest capable tier. |
| [**`rex-approve`**](#-rex-approve)   | Approve unsandboxed Bash commands by running them yourself in a Rex pane.            | You choose what Claude sees afterwards: the output, the exit code only, or your own summary.        |

---

## 📊 `usage-meter`

Adds an always-visible, minimal status bar positioned directly above the input prompt (`AbovePrompt`).

```text
󱜙  opus-5-5 · 84k/1.0M (42%) ·  $1.23
```

### Features

- **Context Window Monitor**: Tracks token usage against total window capacity with percentage indicators.
- **Color-Coded Thresholds**:
  - 🟢 **Green** (`< 40%`): Safe zone; ample room for extended context.
  - 🟡 **Amber** (`40% - 69%`): Moderate usage; considerations for upcoming compaction.
  - 🔴 **Red** (`≥ 70%`): Heavy fill; approaching window limits.
- **Smart Compaction Tracking**: Immediately renders estimated sizes (`~31k/200k (~16%)`) right after `/compact` without
  waiting for the next turn measurement.
- **Session Cost Counter**: Real-time USD spend display updated as prompts complete.
- **Instant Model Switching**: Reacts immediately whenever `/model` is changed.

---

## ⚡ `model-router`

Optimizes costs and execution speed by dynamically routing sub-agents to the most cost-effective Claude model tier
(`opus`, `sonnet`, or `haiku`).

### How It Works

1. **Protects the Main Thread**: The main conversation thread remains untouched on whatever `/model` you configure. This
   prevents cache thrashing and ensures high-level problem understanding stays consistent.
2. **Evaluates Sub-Agent Tasks**: When a sub-agent spawns without an explicit model override, a fast Haiku classifier
   evaluates the sub-agent prompt and task description against a strict rubric.
3. **Runs on the Cheapest Capable Tier**:
   - **`haiku`**: Fast, lightweight lookups, file/symbol searches, listing usages, reading config files, summarizing
     command output, formatting, and one-line changes.
   - **`sonnet`**: Standard feature work, bug fixes with clear causes, writing unit tests, code reviews, and routine
     refactorings.
   - **`opus`**: Open-ended architecture, multi-file refactors, subtle concurrency/performance debugging,
     security-critical changes, and complex multi-step planning.
4. **Toast Alerts**: Displays a subtle toast whenever a sub-agent is routed to a different tier than the main thread.
5. **Usage & Token Telemetry**: Aggregates lifetime spawn counts, input/output tokens, and prompt cache hit/miss stats
   across tiers.

### Slash Commands (`/route`)

Manage sub-agent routing behaviour in Claude Code using the `/route` command:

```bash
# Set routing mode
/route auto           # Haiku intelligently picks the model per sub-agent (default)
/route off            # Disables routing; sub-agents inherit the main thread model
/route sonnet         # Force all sub-agents to a specific tier (opus | sonnet | haiku)

# Check status & telemetry
/route status         # Displays the current mode and quick help
/route stats          # Shows spawn counts, token breakdowns, and recent decisions
/route reset-stats    # Clears historical routing statistics
```

Example stats output:

```text
Sub-agent routing stats (all sessions)
  opus          3 spawns   in   12.4k   out    1.8k   cache read   48.2k   cache write    6.1k
  sonnet       18 spawns   in   64.1k   out   14.2k   cache read  180.5k   cache write   12.0k
  haiku        42 spawns   in   89.3k   out    8.7k   cache read  310.0k   cache write    4.2k

Latest decisions (model, why, agent):
  haiku   router    general-purpose: Find call sites of parseConfig
  sonnet  router    general-purpose: Add unit tests for auth middleware
```

---

## 🖥️ `rex-approve`

When Claude wants to run a Bash command that leaves the sandbox and needs your approval, this plugin opens a
[Rex](https://www.superlogical.com/rex/docs) pane below Claude's with the command prefilled. You read it and run it
yourself, so nothing runs without you, and you decide what Claude learns about the result.

It only works when Claude Code runs in a Rex terminal (`REX_SESSION` and `REX_BLOCK` are set). Elsewhere, and if the
pane cannot be opened, you get the normal approval dialog.

### How It Works

1. **Intercepts**: Claude makes a Bash call with `dangerouslyDisableSandbox`, and your permission rules say it needs
   approval. Commands your allow rules cover still run directly.
2. **Opens a pane**: `rex split` opens a pane below Claude's. It shows the command, Claude's description of it and the
   working directory. The command is at the prompt and you can edit it.
3. **You decide**:
   - **Enter** runs the command in the pane, as you. Interactive prompts such as `sudo` work normally.
   - **Ctrl-C** or an empty line cancels. Claude is told you chose not to run it.
4. **Keep going (optional)**: after the command runs, press **`k`** to run a follow-on command in the same pane. Repeat
   as often as you like. Ctrl-C at the follow-on prompt goes back to the menu.
5. **Choose what Claude sees**:
   - **`y`**: the captured output, for each command. Only this choice reads the pane, with `rex block capture`.
   - **`c`**: only the exit codes.
   - **`w`**: a summary you type. Use this to keep private data (PII) or secrets out of the conversation.
6. **Reports back**: the plugin uses `rex wait` to watch the pane, closes it and gives Claude the result as the Bash
   call's output. If you edited the command first, Claude is told what you actually ran. If you close the pane without
   running anything, Claude is told that.

The command output is never written to a file. The pane script (`scripts/approve.zsh`) writes only the commands, their
exit codes and your choice to a temporary folder, and the plugin deletes it afterwards.

### Slash Commands (`/rex-approve`)

```bash
/rex-approve unsandboxed  # Commands that leave the sandbox and need approval open in a pane (default)
/rex-approve ask          # Every Bash command that needs approval opens in a pane
/rex-approve off          # Use the normal approval dialog
/rex-approve status       # Show the current mode and whether this is a Rex terminal
```

Do not use `ask` in auto mode. The plugin checks permissions before the auto-mode classifier runs, so `ask` sends you
commands that the classifier would have approved.

### Notes

- The plugin hooks `tool.call`, not `PermissionRequest`. Some organisation-managed security plugins stop
  `PermissionRequest` from reaching other plugins.
- The plugin runs `rex` itself, outside Claude's Bash tool, so you do not need allow rules for `rex` commands.
- Claude waits up to an hour for the pane. If you interrupt Claude's turn, the pane closes and the command is reported as
  not run.

---

## 🚀 Getting Started

### 1. Directory Setup

This repository is organized as a Claude Code plugin marketplace (`mike-mods`) defined in
[`.claude-plugin/marketplace.json`](file:///Users/mike/Personal/claude-mods/.claude-plugin/marketplace.json).

```text
claude-mods/
├── .claude-plugin/
│   └── marketplace.json      # Marketplace manifest declaring all plugins
├── model-router/
│   ├── hooks/
│   │   ├── hooks.json        # Hook entrypoints (register.ts)
│   │   ├── register.ts       # Router implementation & command handling
│   │   └── router.test.ts    # Comprehensive test suite
│   └── types/
│       └── index.d.ts        # TypeScript declarations & state augmentations
├── rex-approve/
│   ├── hooks/
│   │   ├── hooks.json        # Hook entrypoints (register.ts)
│   │   └── register.ts       # Bash interception, Rex pane control & /rex-approve
│   └── scripts/
│       └── approve.zsh       # Runs in the Rex pane: prompt, run, follow-ons, share choice
└── usage-meter/
    ├── hooks/
    │   ├── hooks.json        # Hook entrypoints (register.tsx)
    │   ├── register.tsx      # UI hook & event subscriptions
    │   ├── format.ts         # Formatting & color thresholds
    │   └── format.test.ts    # Unit tests
    └── types/
        └── index.d.ts        # TypeScript declarations
```

### 2. Loading into Claude Code

You can enable these plugins in your Claude Code environment either via marketplace or by pointing directly to the
plugin directories.

#### Option A: Local Marketplace

Add this repository directory as a plugin source in your Claude Code configuration:

```bash
# Add this directory as a plugin marketplace or install individual plugins
claude plugin add ./model-router
claude plugin add ./usage-meter
claude plugin add ./rex-approve
```

#### Option B: Project Configuration

To enable these plugins automatically for a specific project, you can reference them in your workspace's
`.claude/config.json` or plugin manifest:

```json
{
  "plugins": [
    "/path/to/claude-mods/model-router",
    "/path/to/claude-mods/usage-meter",
    "/path/to/claude-mods/rex-approve"
  ]
}
```

---

## 🧪 Running Tests

`model-router` and `usage-meter` include test suites using the `claude-code/testing` framework. `rex-approve` has none
yet; it was tested by hand in a Rex terminal.

- **`model-router/hooks/router.test.ts`**: Verifies routing logic, explicit model overrides, fork handling, toast
  triggering, mode toggling, and stats accumulation.
- **`usage-meter/hooks/format.test.ts`**: Verifies context string formatting, post-compaction estimate indicators, cost
  formatting, and color threshold calculations.

---

## 🛠️ Requirements

- **Claude Code** CLI
- For `rex-approve`: the [Rex](https://www.superlogical.com/rex/docs) terminal with its `rex` CLI on your `PATH`, and
  `zsh` at `/bin/zsh`
- Nerd Font or Unicode-compatible terminal (for model icon `󱜙` and cost icon ``)
