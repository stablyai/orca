import { describe, expect, it } from 'vitest'
import {
  makeActivityResult,
  makeWorkingEntryWithoutHistory,
  PANE_KEY
} from './ActivityPrototypePage-test-fixtures'

describe('stale activity with a live terminal', () => {
  it.each([
    ['working', makeWorkingEntryWithoutHistory()],
    ['monitoring', { ...makeWorkingEntryWithoutHistory(), workingMode: 'monitoring' as const }]
  ])('keeps a stale %s pane with a live PTY as unverifiable', (_label, entry) => {
    const result = makeActivityResult({
      entries: { [PANE_KEY]: entry },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      now: 10_000_000
    })

    expect(result.liveAgentByPaneKey[PANE_KEY]?.state).toBe('unverifiable')
    expect(result.events).toEqual([])
    const withoutPty = makeActivityResult({ entries: { [PANE_KEY]: entry }, now: 10_000_000 })
    expect(withoutPty.liveAgentByPaneKey[PANE_KEY]).toBeUndefined()
    const restored = makeActivityResult({
      entries: { [PANE_KEY]: { ...entry, restoredUnconfirmed: true } },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      now: 10_000_000
    })
    expect(restored.liveAgentByPaneKey[PANE_KEY]).toBeUndefined()
  })

  it('keeps a stale blocked pane as Blocked attention, not unverifiable', () => {
    const result = makeActivityResult({
      entries: { [PANE_KEY]: { ...makeWorkingEntryWithoutHistory(), state: 'blocked' } },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      now: 10_000_000
    })

    expect(result.liveAgentByPaneKey[PANE_KEY]).toBeUndefined()
    expect(result.events.map((event) => event.state)).toEqual(['blocked'])
  })
})
