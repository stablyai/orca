import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { Tab } from '../../../shared/tab-types'
import { applyWebSessionTabsSnapshot, type WebSessionTabsSyncState } from './web-session-tabs-sync'
import {
  ENV,
  LEAF_ID,
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

const HOST_GROUP = 'host-group-1'
const DIFF_TAB_ID = 'local-diff-tab'
const DIFF_FILE_ID = `${WT}::diff::unstaged::src/example.ts`

function diffTab(): Tab {
  return {
    id: DIFF_TAB_ID,
    entityId: DIFF_FILE_ID,
    groupId: HOST_GROUP,
    worktreeId: WT,
    contentType: 'diff',
    label: 'example.ts',
    customLabel: null,
    color: null,
    sortOrder: 1,
    createdAt: NOW,
    isPreview: false,
    isPinned: false
  }
}

function mirroredTerminalTab(terminalTabId: string): Tab {
  return {
    id: terminalTabId,
    entityId: terminalTabId,
    groupId: HOST_GROUP,
    worktreeId: WT,
    contentType: 'terminal',
    label: 'codex [working]',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: NOW,
    isPreview: false,
    isPinned: false
  }
}

// Why: STA-4697. An agent status echo republishes the snapshot every turn; the diff tab must
// keep activation instead of falling through to the mirrored terminal.
describe('applyWebSessionTabsSnapshot — diff tab focus', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('does not let a terminal status echo steal activation from an open diff', () => {
    const terminalTabId = toWebTerminalSurfaceTabId('host-tab-1')
    const state = makeState({
      activeTabType: 'editor',
      activeTabTypeByWorktree: { [WT]: 'editor' },
      activeFileId: DIFF_FILE_ID,
      activeFileIdByWorktree: { [WT]: DIFF_FILE_ID },
      tabsByWorktree: {
        [WT]: [
          {
            id: terminalTabId,
            ptyId: 'remote:web-env-1@@terminal-1',
            worktreeId: WT,
            title: 'codex [working]',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: NOW
          }
        ]
      },
      unifiedTabsByWorktree: { [WT]: [mirroredTerminalTab(terminalTabId), diffTab()] },
      tabBarOrderByWorktree: { [WT]: [terminalTabId, DIFF_TAB_ID] },
      groupsByWorktree: {
        [WT]: [
          {
            id: HOST_GROUP,
            worktreeId: WT,
            // Why: the diff is what the user is looking at.
            activeTabId: DIFF_TAB_ID,
            // Why: the mirrored terminal must share the group, or the membership guard in the
            // group writers masks the steal and this test passes pre-fix.
            tabOrder: [terminalTabId, DIFF_TAB_ID],
            recentTabIds: [terminalTabId, DIFF_TAB_ID]
          }
        ]
      },
      activeGroupIdByWorktree: { [WT]: HOST_GROUP }
    })

    const statusEcho = makeSnapshot(
      [
        {
          type: 'terminal',
          id: `host-tab-1::${LEAF_ID}`,
          title: 'codex [thinking]',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1'
        }
      ],
      {
        activeTabId: `host-tab-1::${LEAF_ID}`,
        activeTabType: 'terminal',
        tabGroups: [{ id: HOST_GROUP, activeTabId: 'host-tab-1', tabOrder: ['host-tab-1'] }]
      }
    )

    const patch = applyWebSessionTabsSnapshot(
      state,
      statusEcho,
      ENV,
      NOW + 10
    ) as Partial<WebSessionTabsSyncState>

    const nextGroups = patch.groupsByWorktree?.[WT] ?? state.groupsByWorktree[WT]
    const activeGroupId = patch.activeGroupIdByWorktree?.[WT] ?? state.activeGroupIdByWorktree[WT]
    const nextTabs = patch.unifiedTabsByWorktree?.[WT] ?? state.unifiedTabsByWorktree[WT]

    expect(nextGroups?.find((group) => group.id === HOST_GROUP)?.activeTabId).toBe(DIFF_TAB_ID)
    expect(activeGroupId).toBe(HOST_GROUP)
    // Why: the reported symptom left the tab present but deactivated.
    expect(nextTabs?.some((tab) => tab.id === DIFF_TAB_ID)).toBe(true)
  })
})
