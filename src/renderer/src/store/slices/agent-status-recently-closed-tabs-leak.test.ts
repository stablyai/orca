/**
 * Memory-leak regression: recentlyClosedAgentStatusTabIds must stay bounded.
 *
 * `recentlyClosedAgentStatusTabIds` is a grown-only tombstone set keyed by tabId.
 * Every `dropAgentStatusByTabPrefix` call plants `[tabId]: true` so late
 * agent-hook replays for a just-closed tab can be rejected
 * (`isRecentlyClosedAgentStatusTab`). tabIds never recur and nothing purges the
 * set — it is not swept by `buildWorktreePurgeState` and has no size cap — so
 * before the fix it grew one permanent entry per closed agent tab for the whole
 * renderer session. This is the direct sibling of `retainedAgentsByPaneKey`
 * (capped) and the ptyId/paneKey maps swept on worktree removal; it was the one
 * grown-only map both hardening passes missed.
 *
 * The fix caps it to MAX_RECENTLY_CLOSED_AGENT_STATUS_TABS, evicting the
 * oldest-closed tabIds (insertion order == close order, so the most recently
 * closed tabs — the only ones that can still be racing a late replay — survive).
 */
import { describe, expect, it } from 'vitest'
import { createTestStore } from './store-test-helpers'

// MAX_RECENTLY_CLOSED_AGENT_STATUS_TABS is module-private; mirror its value here.
const MAX_RECENTLY_CLOSED_AGENT_STATUS_TABS = 500

describe('recentlyClosedAgentStatusTabIds stays bounded (leak regression)', () => {
  it('caps the tombstone set and keeps the most recently closed tabIds', () => {
    const store = createTestStore()

    // Drive the production close path with more distinct tabIds than the cap
    // allows — one call per closed tab, as production does.
    const total = MAX_RECENTLY_CLOSED_AGENT_STATUS_TABS + 200
    for (let i = 0; i < total; i++) {
      store.getState().dropAgentStatusByTabPrefix(`tab-${i}`)
    }

    const closed = store.getState().recentlyClosedAgentStatusTabIds
    // Bounded — not `total`. Without the cap this is total.
    expect(Object.keys(closed)).toHaveLength(MAX_RECENTLY_CLOSED_AGENT_STATUS_TABS)

    // The most recently closed tabs survive; the oldest are evicted.
    expect(closed[`tab-${total - 1}`]).toBe(true)
    expect(closed['tab-0']).toBeUndefined()
    // The exact eviction boundary: everything before (total - cap) is gone.
    expect(closed[`tab-${total - MAX_RECENTLY_CLOSED_AGENT_STATUS_TABS - 1}`]).toBeUndefined()
    expect(closed[`tab-${total - MAX_RECENTLY_CLOSED_AGENT_STATUS_TABS}`]).toBe(true)
  })

  it('does not evict anything while under the cap', () => {
    const store = createTestStore()
    for (let i = 0; i < MAX_RECENTLY_CLOSED_AGENT_STATUS_TABS; i++) {
      store.getState().dropAgentStatusByTabPrefix(`tab-${i}`)
    }
    const closed = store.getState().recentlyClosedAgentStatusTabIds
    expect(Object.keys(closed)).toHaveLength(MAX_RECENTLY_CLOSED_AGENT_STATUS_TABS)
    expect(closed['tab-0']).toBe(true)
  })

  it('re-closing an existing tabId does not grow the set', () => {
    const store = createTestStore()
    store.getState().dropAgentStatusByTabPrefix('tab-0')
    store.getState().dropAgentStatusByTabPrefix('tab-0')

    const closed = store.getState().recentlyClosedAgentStatusTabIds
    expect(Object.keys(closed)).toHaveLength(1)
    expect(closed['tab-0']).toBe(true)
  })
})
