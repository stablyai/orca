import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import './agent-status'
import { RECENTLY_CLOSED_AGENT_STATUS_TAB_IDS_MAX } from './agent-status-pane-keyed-records'
import { createTestStore } from '../../testing/app-store-test-fixture'

// Propagate renderer dismissal to main’s persisted hook cache or restart resurrects dismissed paneKeys.

const originalWindow = (globalThis as { window?: unknown }).window

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window
  } else {
    ;(globalThis as { window?: unknown }).window = originalWindow
  }
})

function stubWindowApi(): {
  drop: ReturnType<typeof vi.fn>
  dropByTabPrefix: ReturnType<typeof vi.fn>
} {
  const drop = vi.fn()
  const dropByTabPrefix = vi.fn()
  ;(globalThis as { window?: unknown }).window = {
    api: { agentStatus: { drop, dropByTabPrefix } }
  }
  return { drop, dropByTabPrefix }
}

describe('dropAgentStatusByTabPrefix -> IPC fan-out', () => {
  it('FIFO-caps recentlyClosedAgentStatusTabIds so it cannot grow unbounded', () => {
    stubWindowApi()
    const store = createTestStore()
    const cap = RECENTLY_CLOSED_AGENT_STATUS_TAB_IDS_MAX

    for (let i = 0; i < cap + 5; i++) {
      store.getState().dropAgentStatusByTabPrefix(`tab-${i}`)
    }

    const closed = store.getState().recentlyClosedAgentStatusTabIds
    expect(Object.keys(closed)).toHaveLength(cap)
    // Evict oldest closed-tab markers; events beyond the cap cannot still arrive.
    expect(closed['tab-0']).toBeUndefined()
    expect(closed['tab-4']).toBeUndefined()
    expect(closed[`tab-${cap + 4}`]).toBe(true)
  })
})
