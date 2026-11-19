import { useAppStore } from '@/store/index'
import { parsePtySessionId } from '../../../../../shared/terminal/pty/lifecycle/pty-session-id-format'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/workspace/identity/floating-workspace-id'
import { worktreeIdsEqual } from '../../../../../shared/worktree/id'
import { listActivationPtySessions } from './worktree-activation-pty-inventory'
import { adoptLiveWorkspacePtySurfaces } from './worktree-agent-live-surface-adoption'
import { readWorktreeLiveTerminalSurfaceOwners } from '../ownership/worktree-live-terminal-surface-owners'

/** The floating terminal has no activation gate, so a live PTY no floating pane shows gets the same adoption once per launch. */
export async function adoptFloatingTerminalLiveSurfaces(): Promise<void> {
  const sessions = await listActivationPtySessions(
    useAppStore.getState(),
    FLOATING_TERMINAL_WORKTREE_ID
  )
  const livePtyIds = sessions
    .filter(
      (session) =>
        session.exiting !== true &&
        ((session.worktreeId !== undefined &&
          worktreeIdsEqual(session.worktreeId, FLOATING_TERMINAL_WORKTREE_ID)) ||
          parsePtySessionId(session.id).worktreeId === FLOATING_TERMINAL_WORKTREE_ID)
    )
    .map((session) => session.id)
  if (livePtyIds.length > 0) {
    await adoptLiveWorkspacePtySurfaces(
      () => useAppStore.getState(),
      FLOATING_TERMINAL_WORKTREE_ID,
      livePtyIds,
      readWorktreeLiveTerminalSurfaceOwners
    )
  }
}
