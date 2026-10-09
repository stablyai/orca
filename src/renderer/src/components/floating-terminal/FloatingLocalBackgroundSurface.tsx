import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { useFloatingWorkspaceHost } from '@/lib/floating-workspace-host'
import { useAppStore } from '@/store'
import { WorktreeSplitSurface } from '../TerminalWorktreeSplitSurface'

const NO_ACTIVITY_PORTALS: [] = []

export function FloatingLocalBackgroundSurface(): React.JSX.Element | null {
  const environmentId = useFloatingWorkspaceHost((state) => state.environmentId)
  const layout = useAppStore((state) => state.layoutByWorktree[FLOATING_TERMINAL_WORKTREE_ID])
  const focusedGroupId = useAppStore(
    (state) => state.activeGroupIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]
  )
  const cwd = useAppStore((state) => state.floatingWorkspacePath)
  if (!environmentId || !layout || !cwd) {
    return null
  }
  // Mobile creates still need the local host's panes while the panel displays a remote host.
  return (
    <WorktreeSplitSurface
      worktreeId={FLOATING_TERMINAL_WORKTREE_ID}
      worktreePath={cwd}
      layout={layout}
      focusedGroupId={focusedGroupId}
      isVisible={false}
      shouldMeasureHiddenWorktree={false}
      shouldColdParkTerminalPanes={false}
      isForceParked={false}
      activityTerminalPortals={NO_ACTIVITY_PORTALS}
      backgroundMountTabIds={null}
      activationDeferredMountTabIds={null}
    />
  )
}
