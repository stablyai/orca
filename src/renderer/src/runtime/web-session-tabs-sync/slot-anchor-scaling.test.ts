import { beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { applyWebSessionTabsSnapshot } from './snapshot-api'
import {
  ENV,
  LEAF_ID,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from '../web-session-tabs-sync-test-harness'
import * as slotAnchor from './slot-anchor'

vi.mock('../../store', () => ({ useAppStore: { setState: vi.fn() } }))
vi.mock('./slot-anchor', async (load) => {
  const actual = await load<typeof slotAnchor>()
  return { ...actual, slotAnchorLocalTabIds: vi.fn(actual.slotAnchorLocalTabIds) }
})

type Row = RuntimeMobileSessionTabsResult['tabs'][number]
const terminal = (hostTabId: string): Row => ({
  type: 'terminal',
  id: `${hostTabId}::${LEAF_ID}`,
  parentTabId: hostTabId,
  leafId: LEAF_ID,
  title: hostTabId,
  isActive: false,
  status: 'ready',
  terminal: `handle-${hostTabId}`
})
const frame = (rows: Row[], snapshotVersion: number) =>
  makeSnapshot(rows, {
    snapshotVersion,
    tabGroups: [{ id: 'host-group-1', activeTabId: null, tabOrder: rows.map((row) => row.id) }]
  })

beforeEach(resetWebSessionTabsSyncTestState)

it.each([50, 500])(
  'does no anchor work for %i tabs without a switch, and a fixed amount with one',
  (n) => {
    const rows = Array.from({ length: n }, (_, index) => terminal(`host-${index}`))
    const resolve = vi.mocked(slotAnchor.slotAnchorLocalTabIds)
    resolve.mockClear()
    const shown = {
      ...makeState(),
      ...applyWebSessionTabsSnapshot(makeState(), frame(rows, 1), ENV, NOW)
    }
    applyWebSessionTabsSnapshot(shown, frame(rows, 2), ENV, NOW)
    expect(resolve).not.toHaveBeenCalled()
    const switched: Row = {
      type: 'agent-session',
      id: 'agent-session:chat',
      title: 'Codex',
      sessionId: 'chat',
      agent: 'codex',
      isActive: false,
      after: { tabId: 'host-0' }
    }
    applyWebSessionTabsSnapshot(shown, frame([...rows, switched], 3), ENV, NOW)
    expect(resolve.mock.calls.length).toBeGreaterThan(0)
    expect(resolve.mock.calls.length).toBeLessThanOrEqual(4)
  }
)

it('reads this client’s tabs a linear number of times per frame as the workspace grows', () => {
  const reads = (n: number): number => {
    const rows = Array.from({ length: n }, (_, index) => terminal(`host-${index}`))
    const shown = {
      ...makeState(),
      ...applyWebSessionTabsSnapshot(makeState(), frame(rows, 1), ENV, NOW)
    }
    let count = 0
    const tabs = new Proxy(shown.unifiedTabsByWorktree[WT]!, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) {
          count += 1
        }
        return Reflect.get(target, key, receiver)
      }
    })
    applyWebSessionTabsSnapshot(
      { ...shown, unifiedTabsByWorktree: { [WT]: tabs } },
      frame(rows, 2),
      ENV,
      NOW
    )
    return count
  }
  expect(reads(500)).toBeLessThanOrEqual(15 * reads(50))
})
