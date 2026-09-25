import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import { applyWebSessionTabsSnapshot, type WebSessionTabsSyncState } from './web-session-tabs-sync'
import {
  ENV,
  NOW,
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

const LOCAL_GROUP_ID = 'local-group-1'

function localEditorTab(): Tab {
  return {
    id: 'local-editor-tab',
    entityId: '/repo/NOTES.md',
    groupId: LOCAL_GROUP_ID,
    worktreeId: WT,
    contentType: 'editor',
    label: 'NOTES.md',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: NOW,
    isPreview: false,
    isPinned: false
  }
}

function localGroup(): TabGroup {
  return {
    id: LOCAL_GROUP_ID,
    worktreeId: WT,
    activeTabId: 'local-editor-tab',
    tabOrder: ['local-editor-tab'],
    recentTabIds: ['local-editor-tab']
  }
}

function stateWithLocalGroup(): WebSessionTabsSyncState {
  return makeState({
    unifiedTabsByWorktree: { [WT]: [localEditorTab()] },
    groupsByWorktree: { [WT]: [localGroup()] },
    activeGroupIdByWorktree: { [WT]: LOCAL_GROUP_ID },
    layoutByWorktree: { [WT]: { type: 'leaf', groupId: LOCAL_GROUP_ID } }
  })
}

// Host group whose tabs are absent from this snapshot: the host names groups but
// publishes no layout for them, which is the shape that used to duplicate leaves.
function snapshotWithUnmappedHostGroup(): ReturnType<typeof makeSnapshot> {
  return makeSnapshot([], {
    activeGroupId: 'host-group-1',
    activeTabId: null,
    tabGroups: [{ id: 'host-group-1', activeTabId: 'host-tab-1', tabOrder: ['host-tab-1'] }]
  })
}

function collectLeafGroupIds(layout: unknown, out: string[] = []): string[] {
  const node = layout as { type: string; groupId?: string; first?: unknown; second?: unknown }
  if (!node) {
    return out
  }
  if (node.type === 'leaf') {
    out.push(node.groupId!)
    return out
  }
  collectLeafGroupIds(node.first, out)
  collectLeafGroupIds(node.second, out)
  return out
}

describe('applyWebSessionTabsSnapshot layout composition', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('never places one tab group in two layout leaves', () => {
    const patch = applyWebSessionTabsSnapshot(
      stateWithLocalGroup(),
      snapshotWithUnmappedHostGroup(),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const leaves = collectLeafGroupIds(
      patch.layoutByWorktree?.[WT] ?? { type: 'leaf', groupId: LOCAL_GROUP_ID }
    )
    expect(leaves).toEqual([LOCAL_GROUP_ID])
  })

  it('does not grow the layout when the same snapshot is applied twice', () => {
    let state = stateWithLocalGroup()
    for (let i = 0; i < 3; i++) {
      resetWebSessionTabsSyncTestState()
      const patch = applyWebSessionTabsSnapshot(
        state,
        snapshotWithUnmappedHostGroup(),
        ENV,
        NOW
      ) as Partial<WebSessionTabsSyncState>
      state = { ...state, ...patch }
    }

    expect(collectLeafGroupIds(state.layoutByWorktree[WT])).toEqual([LOCAL_GROUP_ID])
  })
})
