import { expect, test } from 'claude-code/testing'
import { colour, meter } from './format'

test('shows model, context fill and cost', () => {
  expect(meter('claude-opus-5-5', { context: { tokens: 84_200, window: 200_000, percent: 42 }, cost: { usd: 1.234 } }))
    .toEqual({ text: 'opus-5-5 · 84k/200k (42%) · ~$1.23', percent: 42 })
})

test('marks an estimated size', () => {
  expect(meter('claude-opus-5-5', { context: { tokens: 31_000, window: 200_000, percent: 16 }, cost: { usd: 1.234 } }, true))
    .toEqual({ text: 'opus-5-5 · ~31k/200k (~16%) · ~$1.23', percent: 16 })
})

test('handles no response yet and no cost ledger', () => {
  expect(meter('claude-haiku-4-5-20251001', { context: { window: 1_000_000 } }))
    .toEqual({ text: 'haiku-4-5 · –/1.0M', percent: -1 })
})

test('colours green, amber, red at 40% and 70%', () => {
  expect([0, 39, 40, 69, 70, 100].map(colour)).toEqual(['success', 'success', 'warning', 'warning', 'error', 'error'])
  expect(colour(-1)).toBeUndefined()
})
