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
const terminal = (hostTabId: string): Extract<Row, { type: 'terminal' }> => ({
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

it.each([0, 10])(
  'reads this client’s tabs a linear number of times per frame as the workspace grows, with %i in 100 chats switched',
  (switchedPer100) => {
    const reads = (n: number): number => {
      // K = n / 10 chats beside the terminals; each was switched to a terminal in its slot.
      const switched = Math.floor((n * switchedPer100) / 100)
      const chats = Array.from({ length: switched }, (_, index): Row => ({
        type: 'agent-session',
        id: `agent-session:chat-${index}`,
        title: 'Codex',
        sessionId: `chat-${index}`,
        agent: 'codex',
        isActive: false
      }))
      const rows = Array.from({ length: n - switched }, (_, index) => terminal(`host-${index}`))
      const shown = {
        ...makeState(),
        ...applyWebSessionTabsSnapshot(makeState(), frame([...chats, ...rows], 1), ENV, NOW)
      }
      const next = [
        ...chats.map((chat, index): Row => ({
          ...terminal(`switched-${index}`),
          replaces: { tabId: chat.id }
        })),
        ...rows
      ]
      let count = 0
      // Every tab read goes through its index's getter.
      const tabs = [...shown.unifiedTabsByWorktree[WT]!]
      tabs.forEach((tab, index) =>
        Object.defineProperty(tabs, index, {
          get: () => {
            count += 1
            return tab
          }
        })
      )
      applyWebSessionTabsSnapshot(
        { ...shown, unifiedTabsByWorktree: { [WT]: tabs } },
        frame(next, 2),
        ENV,
        NOW
      )
      return count
    }
    expect(reads(500)).toBeLessThanOrEqual(15 * reads(50))
  }
)
