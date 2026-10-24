import type { RuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import type { createTestStore } from '../../store/slices/store-test-helpers'
type TestStore = ReturnType<typeof createTestStore>
const VIEWED = 'repo1::/repo1/viewed'
const BACKGROUND = 'repo1::/repo1/background'

/** Everything the user can see or type into on the desktop. */
export function screenState(store: TestStore): unknown {
  const s = store.getState()
  return {
    activeWorktreeId: s.activeWorktreeId,
    activeView: s.activeView,
    activeTabType: s.activeTabType,
    activeFileId: s.activeFileId,
    activeTabId: s.activeTabId,
    viewedActiveFile: s.activeFileIdByWorktree[VIEWED],
    viewedActiveTabType: s.activeTabTypeByWorktree[VIEWED],
    viewedActiveGroup: s.activeGroupIdByWorktree[VIEWED],
    viewedGroups: s.groupsByWorktree[VIEWED]?.map((group) => ({
      id: group.id,
      activeTabId: group.activeTabId
    })),
    pendingEditorFocusRequest: s.pendingEditorFocusRequest,
    pendingRevealWorktree: s.pendingRevealWorktree,
    backgroundVisitedAt: s.lastVisitedAtByWorktreeId[BACKGROUND]
  }
}

export type OpenFilePayload = {
  worktreeId: string
  filePath: string
  relativePath: string
  runtimeEnvironmentId?: string | null
  navigation?: RuntimeNavigationTarget
  position?: { line: number; column?: number }
}
export type OpenDiffPayload = OpenFilePayload & { staged: boolean }
