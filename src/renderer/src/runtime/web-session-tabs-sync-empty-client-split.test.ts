import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import {
  recordWebSessionTerminalPlacement,
  resetWebSessionTerminalPlacementsForTests
} from './web-session-terminal-placement'
import { applyWebSessionTabsSnapshot, type WebSessionTabsSyncState } from './web-session-tabs-sync'
import {
  ENV,
  LEAF_ID,
  NOW,
  SECOND_LEAF_ID,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

const HOST_GROUP = 'host-group-1'
const SPLIT_GROUP = 'client-split-group'
const T1 = toWebTerminalSurfaceTabId('host-tab-1')
const T2 = toWebTerminalSurfaceTabId('host-tab-2')

function terminalSurface(
  hostTabId: string,
  leafId: string,
  isActive: boolean
): RuntimeMobileSessionTabsResult['tabs'][number] {
  return {
    type: 'terminal',
    id: `${hostTabId}::${leafId}`,
    title: hostTabId,
    parentTabId: hostTabId,
    leafId,
    isActive,
    status: 'ready',
    terminal: `terminal-${hostTabId}`
  }
}

function hostSnapshot(hostTabIds: string[]): RuntimeMobileSessionTabsResult {
  const surfaces = hostTabIds.map((hostTabId, index) =>
    terminalSurface(hostTabId, index === 0 ? LEAF_ID : SECOND_LEAF_ID, index === 0)
  )
  return makeSnapshot(surfaces, {
    activeGroupId: HOST_GROUP,
    activeTabId: surfaces[0].id,
    tabGroups: [{ id: HOST_GROUP, activeTabId: 'host-tab-1', tabOrder: hostTabIds }],
    tabGroupLayout: { type: 'leaf', groupId: HOST_GROUP }
  })
}

function layoutLeafGroupIds(layout: TabGroupLayoutNode | undefined): string[] {
  if (!layout) {
    return []
  }
  return layout.type === 'leaf'
    ? [layout.groupId]
    : [...layoutLeafGroupIds(layout.first), ...layoutLeafGroupIds(layout.second)]
}

function applySnapshot(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult
): WebSessionTabsSyncState {
  return { ...state, ...applyWebSessionTabsSnapshot(state, snapshot, ENV, NOW) }
}

describe('an empty client split awaiting a paired-runtime terminal', () => {
  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    resetWebSessionTerminalPlacementsForTests()
  })

  // A session dropped on a pane edge splits first; the host tab only lands once its create answers.
  it('survives snapshots published before the terminal lands, then receives it', () => {
    let state = makeState({
      activeGroupIdByWorktree: { [WT]: SPLIT_GROUP },
      groupsByWorktree: {
        [WT]: [
          { id: HOST_GROUP, worktreeId: WT, activeTabId: T1, tabOrder: [T1] },
          { id: SPLIT_GROUP, worktreeId: WT, activeTabId: null, tabOrder: [] }
        ]
      },
      layoutByWorktree: {
        [WT]: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: HOST_GROUP },
          second: { type: 'leaf', groupId: SPLIT_GROUP }
        }
      },
      unifiedTabsByWorktree: {
        [WT]: [
          {
            id: T1,
            worktreeId: WT,
            groupId: HOST_GROUP,
            contentType: 'terminal',
            entityId: T1,
            label: T1,
            sortOrder: 0,
            createdAt: NOW,
            isPreview: false,
            isPinned: false,
            customLabel: null,
            color: null
          }
        ]
      }
    })

    state = applySnapshot(state, hostSnapshot(['host-tab-1']))

    expect(state.groupsByWorktree[WT]?.map((group) => group.id)).toEqual([HOST_GROUP, SPLIT_GROUP])
    expect(layoutLeafGroupIds(state.layoutByWorktree[WT])).toEqual([HOST_GROUP, SPLIT_GROUP])

    recordWebSessionTerminalPlacement({
      environmentId: ENV,
      worktreeId: WT,
      hostTabId: 'host-tab-2',
      groupId: SPLIT_GROUP
    })
    state = applySnapshot(state, hostSnapshot(['host-tab-1', 'host-tab-2']))

    const groups = state.groupsByWorktree[WT]
    expect(groups?.find((group) => group.id === HOST_GROUP)?.tabOrder).toEqual([T1])
    expect(groups?.find((group) => group.id === SPLIT_GROUP)?.tabOrder).toEqual([T2])
    expect(layoutLeafGroupIds(state.layoutByWorktree[WT])).toEqual([HOST_GROUP, SPLIT_GROUP])
  })
})
