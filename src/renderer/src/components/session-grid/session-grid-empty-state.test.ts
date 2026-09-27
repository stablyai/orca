import { describe, expect, it } from 'vitest'
import { resolveSessionGridEmptyStateReason } from './session-grid-empty-state'
import type { SessionGridBucketCounts } from './session-grid-items-builder'

const NO_CARDS: SessionGridBucketCounts = { attention: 0, working: 0, done: 0, idle: 0 }

describe('resolveSessionGridEmptyStateReason', () => {
  it('says there are none when there really are none', () => {
    expect(
      resolveSessionGridEmptyStateReason({
        allItemCount: 0,
        stateCounts: NO_CARDS,
        hiddenCount: 0,
        activeFilter: 'all'
      })
    ).toBe('no-sessions')
  })

  // The screen used to say "No active sessions" next to a lit chip proving otherwise.
  it('blames the state chip when cards survived every earlier step', () => {
    expect(
      resolveSessionGridEmptyStateReason({
        allItemCount: 3,
        stateCounts: { ...NO_CARDS, idle: 3 },
        hiddenCount: 0,
        activeFilter: 'all'
      })
    ).toBe('filtered')
  })

  it('blames the workspace chip when it points somewhere with no sessions', () => {
    expect(
      resolveSessionGridEmptyStateReason({
        allItemCount: 3,
        stateCounts: NO_CARDS,
        hiddenCount: 0,
        activeFilter: 'wt-2'
      })
    ).toBe('filtered')
  })

  it('blames hiding when the user put every card in scope away', () => {
    expect(
      resolveSessionGridEmptyStateReason({
        allItemCount: 2,
        stateCounts: NO_CARDS,
        hiddenCount: 2,
        activeFilter: 'all'
      })
    ).toBe('hidden')
  })

  /**
   * Both could explain it, and the answer has to be the step that took the LAST card. The
   * user just pressed a state chip and watched two cards go; telling them everything here is
   * hidden — about two other cards they hid earlier — sends them to the wrong button.
   */
  it('blames the state chip over the hiding when the state chip is what emptied it', () => {
    expect(
      resolveSessionGridEmptyStateReason({
        allItemCount: 4,
        stateCounts: { ...NO_CARDS, idle: 2 },
        hiddenCount: 2,
        activeFilter: 'all'
      })
    ).toBe('filtered')
  })

  it('blames hiding when it emptied the workspace the chip is pointing at', () => {
    expect(
      resolveSessionGridEmptyStateReason({
        allItemCount: 4,
        stateCounts: NO_CARDS,
        hiddenCount: 2,
        activeFilter: 'wt-1'
      })
    ).toBe('hidden')
  })
})
