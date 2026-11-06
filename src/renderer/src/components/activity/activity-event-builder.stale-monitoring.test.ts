import { describe, expect, it } from 'vitest'
import {
  makeActivityResult,
  makeWorkingEntryWithoutHistory,
  PANE_KEY
} from './ActivityPrototypePage-test-fixtures'

describe('stale monitoring activity', () => {
  it('retains only confirmed monitoring panes with a live terminal as unverifiable', () => {
    const entry = { ...makeWorkingEntryWithoutHistory(), workingMode: 'monitoring' as const }
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
})
