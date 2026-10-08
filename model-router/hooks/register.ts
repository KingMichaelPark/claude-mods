import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnUsage } from 'claude-code'

import type { Mode } from '../types'

// Routes sub-agents only. The main thread stays on whatever /model is set to:
// switching it mid-conversation costs its prompt cache and risks handing a
// hard task to a weaker model halfway through.

const TIERS = ['opus', 'sonnet', 'haiku'] as const
type Tier = (typeof TIERS)[number]

// The model that makes the routing decision.
const ROUTER_MODEL = 'haiku'
const ROUTER_TIMEOUT_MS = 8000
const MAX_TASK_CHARS = 6000
const RECENT_KEPT = 50
const STATS_KEY = 'stats'

const RUBRIC = `You choose which model runs a coding sub-agent: the cheapest one that will do the job well.
Reply with exactly one word: opus, sonnet or haiku.

opus: hard or open-ended work. Architecture and design decisions, multi-file refactors,
difficult debugging with unclear causes, security-sensitive changes, subtle concurrency or
performance problems, long multi-step plans, or anything where a wrong answer is costly.

sonnet: normal software work. Writing or changing a feature, fixing a bug with a clear cause,
writing tests, code review, explaining a moderately complex piece of code, routine refactors.

haiku: small, mechanical or lookup work. Finding files or symbols, listing usages, reading a few
files and reporting what they say, running a command and summarising its output, renames,
formatting, one-line edits.

Examples:
"Find every call site of parseConfig and list the files" -> haiku
"Read the README and package.json and summarise the build steps" -> haiku
"Add a --dry-run flag to the deploy script and update its tests" -> sonnet
"Review this diff for correctness bugs" -> sonnet
"Work out why the cache returns stale data under concurrent writes" -> opus
"Design a migration plan from REST to event-driven messaging across the services" -> opus

If unsure between two tiers, pick the higher one.`

type Source = 'router' | 'pinned' | 'requested' | 'inherited'

type Decision = {
  at: number
  agentId: string
  subagentType: string
  description: string
  model: string
  parentModel: string
  source: Source
}

type TierTotals = {
  spawns: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

type Stats = { totals: Partial<Record<Tier, TierTotals>>; recent: Decision[] }

const modeAtom = atom({ plugin: 'model-router', key: 'mode' } as const, 'auto' as Mode)

const isTier = (s: string): s is Tier => (TIERS as readonly string[]).includes(s)
const isMode = (s: string): s is Mode => s === 'auto' || s === 'off' || isTier(s)
const tierOf = (model: string): Tier | undefined =>
  TIERS.find(tier => model.toLowerCase().includes(tier))

const emptyTotals = (): TierTotals => ({ spawns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

const loadStats = async ($: EngineInterface): Promise<Stats> => {
  const raw = (await $.store.get(STATS_KEY)) as Stats | undefined

  return raw ?? { totals: {}, recent: [] }
}

// Stats are best effort: a failed write never gets in the way of a spawn.
const changeStats = async ($: EngineInterface, fn: (stats: Stats) => void) => {
  try {
    const stats = await loadStats($)
    fn(stats)
    await $.store.set(STATS_KEY, stats)
  } catch {
    // ignored
  }
}

// Which tier each running sub-agent was started on, for its usage at the end.
const running = new Map<string, Tier>()

const showStatus = ($: EngineInterface, mode: Mode) =>
  $.ui.status(mode === 'auto' ? undefined : mode === 'off' ? 'route: off' : `route: sub-agents pinned ${mode}`)

// Asks Haiku which tier fits `task`; undefined when it cannot say.
const decide = async ($: EngineInterface, task: string): Promise<Tier | undefined> => {
  const reply = await $.model
    .complete({
      model: ROUTER_MODEL,
      system: RUBRIC,
      prompt: `Sub-agent task to route:\n<task>\n${task.slice(0, MAX_TASK_CHARS)}\n</task>`,
      maxTokens: 5,
      timeoutMs: ROUTER_TIMEOUT_MS,
    })
    .catch(() => undefined)
  if (reply === undefined || !reply.isAnswered) return undefined
  const word = reply.text.toLowerCase().match(/\b(opus|sonnet|haiku)\b/)?.[1]

  return word !== undefined && isTier(word) ? word : undefined
}

const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1e3).toFixed(1)}k` : `${n}`)

const statsText = (stats: Stats) => {
  const rows = TIERS.map(tier => {
    const t = stats.totals[tier] ?? emptyTotals()

    return `  ${tier.padEnd(7)} ${String(t.spawns).padStart(5)} spawns   in ${fmt(t.input).padStart(7)}   out ${fmt(t.output).padStart(7)}   cache read ${fmt(t.cacheRead).padStart(7)}   cache write ${fmt(t.cacheWrite).padStart(7)}`
  })
  const recent = stats.recent
    .slice(-10)
    .reverse()
    .map(d => `  ${(tierOf(d.model) ?? d.model).padEnd(7)} ${d.source.padEnd(9)} ${d.subagentType}: ${d.description}`)

  return [
    'Sub-agent routing stats (all sessions)',
    ...rows,
    '',
    recent.length === 0 ? 'No sub-agents routed yet.' : 'Latest decisions (model, why, agent):',
    ...recent,
  ].join('\n')
}

const HELP = [
  'Usage: /route [auto | off | opus | sonnet | haiku | status | stats | reset-stats]',
  '  auto    let Haiku pick a model for each sub-agent (default)',
  '  off     stop routing; sub-agents use their usual model',
  '  opus|sonnet|haiku   run every sub-agent on that model',
  '  stats   spawns and tokens per model, and the latest decisions',
].join('\n')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'route',
      description: 'Sub-agent model router: auto, off, pin a model, or stats',
      argumentHint: '[auto|off|opus|sonnet|haiku|status|stats|reset-stats]',
    })
    showStatus($, await read($, modeAtom))

    return next(e)
  })

  on('command.run', { command: 'route' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'stats') return { text: statsText(await loadStats($)) }
    if (arg === 'reset-stats') {
      await $.store.delete(STATS_KEY)

      return { text: 'Sub-agent routing stats cleared.' }
    }
    if (arg === '' || arg === 'status') return { text: `Sub-agent router: ${await read($, modeAtom)}\n${HELP}` }
    if (!isMode(arg)) return { text: HELP }
    await update($, modeAtom, () => arg)
    showStatus($, arg)

    return { text: `Sub-agent router set to ${arg}.` }
  })

  on('agent.spawn', async ($, e, next) => {
    const mode = await read($, modeAtom)
    // Forks always inherit, and a model the caller named explicitly wins.
    const canRoute = mode !== 'off' && !e.fork && e.model === undefined
    const tier = !canRoute ? undefined : mode === 'auto' ? await decide($, `${e.description}\n\n${e.prompt}`) : mode
    const started = await next(tier === undefined ? e : { ...e, model: tier })
    if (started.deny !== undefined || started.model === undefined) return started

    const source: Source =
      tier !== undefined ? (mode === 'auto' ? 'router' : 'pinned') : e.model !== undefined ? 'requested' : 'inherited'
    const ranOn = tierOf(started.model)
    const parentTier = tierOf(e.parentModel)
    // A teammate carries a teammateId rather than an agentId.
    const agentId = started.agentId ?? started.teammateId ?? ''
    if (ranOn !== undefined && started.agentId !== undefined) running.set(started.agentId, ranOn)

    if (ranOn !== undefined && ranOn !== parentTier) {
      const why = source === 'router' ? 'router picked' : source === 'pinned' ? 'pinned' : 'requested'
      $.ui.toast(`Sub-agent "${e.description}" runs on ${ranOn} (${why}; main thread: ${parentTier ?? e.parentModel})`, {
        timeoutMs: 6000,
      })
    }

    const decision: Decision = {
      at: await $.clock.now().catch(() => 0),
      agentId,
      subagentType: e.subagentType,
      description: e.description,
      model: started.model,
      parentModel: e.parentModel,
      source,
    }
    await changeStats($, stats => {
      stats.recent = [...stats.recent, decision].slice(-RECENT_KEPT)
      if (ranOn === undefined) return
      const t = (stats.totals[ranOn] ??= emptyTotals())
      t.spawns += 1
    })

    return started
    // Only work before `next` can throw (the code after it is guarded), so a
    // failure here never starts the sub-agent twice: it just runs unrouted.
  }).catch(($, e, next) => next(e))

  // Adds each routed sub-agent's token usage to its tier's totals.
  on('turn.complete', async ($, e, next) => {
    const tier = e.agentId === undefined ? undefined : running.get(e.agentId)
    if (tier !== undefined && e.agentId !== undefined) {
      running.delete(e.agentId)
      const usage: TurnUsage | undefined = e.usage
      if (usage !== undefined) {
        await changeStats($, stats => {
          const t = (stats.totals[tier] ??= emptyTotals())
          t.input += usage.input_tokens
          t.output += usage.output_tokens
          t.cacheRead += usage.cache_read_input_tokens
          t.cacheWrite += usage.cache_creation_input_tokens
        })
      }
    }

    return next(e)
  })
}
