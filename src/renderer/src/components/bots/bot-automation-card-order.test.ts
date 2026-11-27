// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useAutomationCardOrder, type BotAutomationCardRow } from './bot-automation-card'

const row = (key: string, on: boolean, nextAt: number | null): BotAutomationCardRow =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only what ordering reads.
  ({
    key,
    kind: 'automation',
    on,
    failed: false,
    running: false,
    nextAt,
    runFacts: ''
  }) as unknown as BotAutomationCardRow

const keys = (rows: readonly BotAutomationCardRow[]): string[] => rows.map((r) => r.key)

describe('the Automations card order', () => {
  it('keeps the other rows in place when a row deleted here leaves', () => {
    const start = [row('a', true, 100), row('b', true, 200), row('c', true, 300)]
    const { result, rerender } = renderHook(
      ({ rows, hidden }) => useAutomationCardOrder(rows, hidden),
      { initialProps: { rows: start, hidden: new Set<string>() } }
    )
    expect(keys(result.current)).toEqual(['a', 'b', 'c'])
    // B is paused here (ranks last if re-ranked), then A is deleted and hidden.
    const flipped = [row('a', true, 100), row('b', false, 200), row('c', true, 300)]
    rerender({ rows: flipped, hidden: new Set() })
    expect(keys(result.current)).toEqual(['a', 'b', 'c'])
    rerender({ rows: flipped.slice(1), hidden: new Set(['a']) })
    expect(keys(result.current)).toEqual(['b', 'c'])
  })

  it('re-ranks when a row leaves for any other reason', () => {
    const { result, rerender } = renderHook(({ rows }) => useAutomationCardOrder(rows, new Set()), {
      initialProps: { rows: [row('a', true, 100), row('b', true, 200), row('c', true, 300)] }
    })
    rerender({ rows: [row('a', true, 100), row('b', false, 200), row('c', true, 300)] })
    rerender({ rows: [row('b', false, 200), row('c', true, 300)] })
    expect(keys(result.current)).toEqual(['c', 'b'])
  })
})
