import type React from 'react'
import { useAppStore } from '@/store'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import { getPinnedWorktreeDisplayPolicy } from '../../../../../../shared/sidebar-list/row-types'
import { getActiveSidebarWorkspaceId } from '../../../../../../shared/workspace/identity/workspace-scope'
import { useWorktreeListKeyboardNavigation } from './use-keyboard'

const EMPTY_SECTION_ROWS: HostSectionRow[] = []
const EMPTY_SCROLL_REF: React.RefObject<HTMLDivElement | null> = { current: null }
const NOOP_MARK_SCROLL = () => {}

/** Keeps global Previous/Next worktree active for Bots when Projects has no visible rows. */
export function EmptyWorktreeListKeyboardNavigation(): null {
  const activeWorktreeId = useAppStore((s) =>
    s.activeView === 'tasks' || s.activeView === 'activity'
      ? null
      : getActiveSidebarWorkspaceId(s.activeWorkspaceKey, s.activeWorktreeId)
  )
  const activeWorkspaceExecutionHostId = useAppStore((s) => s.activeWorkspaceExecutionHostId)
  const pinnedDisplayPolicy = useAppStore((s) => getPinnedWorktreeDisplayPolicy(s.settings))
  const activeModal = useAppStore((s) => s.activeModal)

  useWorktreeListKeyboardNavigation({
    rows: EMPTY_SECTION_ROWS,
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    pinnedDisplayPolicy,
    scrollRef: EMPTY_SCROLL_REF,
    activeModal,
    markDirectScrollInput: NOOP_MARK_SCROLL
  })
  return null
}
