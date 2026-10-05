import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  noteTerminalPresentationIntent,
  readTerminalPresentationIntentRevision,
  readTerminalPresentationStamp,
  readTerminalPresentationToken,
  resetTerminalPresentationStampsForTest
} from './terminal-presentation-stamp'

afterEach(() => {
  resetTerminalPresentationStampsForTest()
  vi.useRealTimers()
})

describe('terminal presentation intents', () => {
  it('advances only on an intent, same value included, and orders it by its wall clock', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 2_000 })
    const first = readTerminalPresentationToken('t1', 'p1')
    expect(readTerminalPresentationToken('t1', 'p1')).toBe(first)
    const globalBefore = readTerminalPresentationIntentRevision()
    noteTerminalPresentationIntent('t1')
    expect(readTerminalPresentationToken('t1', 'p1')).not.toBe(first)
    expect(readTerminalPresentationStamp('t1')).toEqual({ revision: 1, changedAtMs: 2_000 })
    expect(readTerminalPresentationIntentRevision()).toBe(globalBefore + 1)
    // Another tab's intent leaves this one's token alone.
    const settled = readTerminalPresentationToken('t1', 'p1')
    noteTerminalPresentationIntent('t2')
    expect(readTerminalPresentationToken('t1', 'p1')).toBe(settled)
  })

  it("scopes the token to the pane's binding: a rebind changes it, a sibling's does not", () => {
    const paneA = readTerminalPresentationToken('t1', 'p-agent')
    expect(readTerminalPresentationToken('t1', 'p-agent')).toBe(paneA)
    expect(readTerminalPresentationToken('t1', 'p-agent-respawned')).not.toBe(paneA)
  })
})
