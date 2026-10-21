import { Columns2, X } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { activateWorktreeFromSidebar } from '@/lib/sidebar-worktree-activation'
import { useAppStore } from '@/store'
import { isWorktreeInSplitViewPair } from '@/store/slices/worktree-split-view'
import type { ExecutionHostId } from '../../../../shared/execution-host'

/** "Open in Split View" beside the active worktree, or "Close Split View" for a paired row. */
export function WorktreeSplitViewMenuItems({
  worktreeId,
  executionHostId,
  disabled
}: {
  worktreeId: string
  executionHostId: ExecutionHostId | undefined
  disabled: boolean
}): React.JSX.Element | null {
  // Why the active check too: a pair the user navigated away from is not on screen to close.
  const isPaired = useAppStore(
    (state) =>
      isWorktreeInSplitViewPair(state.worktreeSplitViewPair, worktreeId) &&
      isWorktreeInSplitViewPair(state.worktreeSplitViewPair, state.activeWorktreeId)
  )
  const canOpen = useAppStore(
    (state) => state.activeWorktreeId !== null && state.activeWorktreeId !== worktreeId
  )
  if (isPaired) {
    return (
      <DropdownMenuItem
        onSelect={() => useAppStore.getState().closeWorktreeSplitView()}
        disabled={disabled}
      >
        <X className="size-3.5" />
        {translate(
          'auto.components.sidebar.WorktreeContextMenu.closeSplitView',
          'Close Split View'
        )}
      </DropdownMenuItem>
    )
  }
  if (!canOpen) {
    return null
  }
  return (
    <DropdownMenuItem
      onSelect={() => {
        if (useAppStore.getState().openWorktreeInSplitView(worktreeId, executionHostId ?? null)) {
          // Why activate the new side: the other side was the active one, so both are mounted.
          void activateWorktreeFromSidebar(worktreeId, executionHostId)
        }
      }}
      disabled={disabled}
    >
      <Columns2 className="size-3.5" />
      {translate(
        'auto.components.sidebar.WorktreeContextMenu.openInSplitView',
        'Open in Split View'
      )}
    </DropdownMenuItem>
  )
}
