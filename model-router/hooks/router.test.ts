import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const USAGE = {
  input_tokens: 1,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

// The engine beneath the mod: a fake Haiku that answers by keyword, a spawn
// that echoes the model it was given, and recorders for toasts and asks.
const world = (on: On) => {
  const asked: string[] = []
  const spawned: (string | undefined)[] = []
  const toasts: string[] = []
  mock.store(on)
  mock.clock(on)
  on('model.complete', ($, e) => {
    asked.push(e.prompt)
    const tier = /architecture/.test(e.prompt) ? 'opus' : /rename|find/i.test(e.prompt) ? 'haiku' : 'sonnet'

    return { value: { isAnswered: true, text: tier, usage: USAGE } } as never
  })
  on('agent.spawn', ($, e) => {
    spawned.push(e.model)
    const model = e.model ?? e.parentModel

    return { model, agentId: `a${spawned.length}` }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined } as never
  })
  on('ui.status', () => ({ value: undefined }) as never)

  return { asked, spawned, toasts }
}

const BASE = {
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
} as const

const spawn = ($: Engine, fields: Record<string, unknown>) => $.agent.spawn({ ...BASE, ...fields } as never)

const route = ($: Engine, args: string) =>
  $.command.run({
    command: 'route',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  } as never)

test('picks a model for sub-agents unless one was named or it is a fork', async ($, on) => {
  const { spawned, asked } = world(on)

  await spawn($, { description: 'Find helpers', prompt: 'find util call sites' })
  await spawn($, { description: 'Plan', prompt: 'architecture', model: 'sonnet' })
  await spawn($, { description: 'Fork', prompt: 'architecture', fork: true })

  expect(spawned).toEqual(['haiku', 'sonnet', undefined])
  expect(asked.length).toBe(1)
})

test('toasts only when the sub-agent runs on a different model from the main thread', async ($, on) => {
  const { toasts } = world(on)

  await spawn($, { description: 'Find helpers', prompt: 'find util call sites' })
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('haiku')
  expect(toasts[0]).toContain('router picked')

  await spawn($, { description: 'Design', prompt: 'architecture review' })
  expect(toasts.length).toBe(1)
})

test('/route pins, turns off, and the mode survives a reread', async ($, on) => {
  const { spawned, asked } = world(on)

  await route($, 'sonnet')
  await spawn($, { description: 'Design', prompt: 'architecture' })
  expect(spawned.at(-1)).toBe('sonnet')
  expect(asked.length).toBe(0)

  await route($, 'off')
  await spawn($, { description: 'Find', prompt: 'find x' })
  expect(spawned.at(-1)).toBe(undefined)

  const status = await route($, 'status')
  expect(status.text).toContain('Sub-agent router: off')
})

test('/route stats counts spawns and the sub-agent usage per model', async ($, on) => {
  world(on)
  on('turn.complete', ($, e) => ({ text: e.answer }))

  await spawn($, { description: 'Find helpers', prompt: 'find util call sites' })
  await $.turn.complete({
    answer: 'done',
    durationMs: 10,
    isAborted: false,
    turnId: 't',
    agentId: 'a1',
    reason: 'answer',
    usage: { ...USAGE, input_tokens: 1200, output_tokens: 300, model: 'claude-haiku-5-5' },
  })

  const stats = await route($, 'stats')
  expect(stats.text).toMatch(/haiku\s+1 spawns\s+in\s+1\.2k\s+out\s+300/)
  expect(stats.text).toContain('router')
  expect(stats.text).toContain('Find helpers')

  await route($, 'reset-stats')
  expect((await route($, 'stats')).text).toContain('No sub-agents routed yet.')
})
