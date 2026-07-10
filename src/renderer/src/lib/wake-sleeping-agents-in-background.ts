import {
  BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT,
  WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT,
  type BackgroundMountTerminalWorktreeDetail,
  type WakeHibernatedAgentsWorktreeDetail
} from '@/constants/terminal'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import { isPassiveCompletedHibernationEvidence } from './sleeping-agent-pane-ownership'

/**
 * Wakes a worktree's slept agents on the desktop host renderer with NO desktop
 * navigation — used when a phone (`clientKind: 'mobile'`) opens the worktree.
 * Runs up to three steps, in order:
 *  (a) fire the armed cold-restore `--resume` of the worktree's mounted hidden
 *      hibernated panes (the experimental agent-sleep records; the primary
 *      wake mechanism, since those records are passive for path C);
 *  (b) background-mount so a hibernated pane that is NOT currently mounted
 *      (post-restart / evicted) mounts offscreen and takes the fresh-connect
 *      cold-restore path;
 *  (c) resume the non-passive record classes (manual sleep of a still-working
 *      agent, `origin: 'quit'`) with navigation suppressed.
 * Woken PTYs auto-publish to mobile via the renderer graph republish, so no
 * spawn is awaited.
 */
export function wakeSleepingAgentsForWorktreeInBackground(worktreeId: string): void {
  const worktreeRecords = Object.values(
    useAppStore.getState().sleepingAgentSessionsByPaneKey
  ).filter((record) => record.worktreeId === worktreeId)
  // Why: nothing is slept here, so there is no wake work. Skipping is what keeps
  // a phone browsing many worktrees from permanently background-mounting each one
  // (and reattaching its PTYs) on the desktop host it is paired to.
  if (worktreeRecords.length === 0) {
    return
  }

  window.dispatchEvent(
    new CustomEvent<WakeHibernatedAgentsWorktreeDetail>(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, {
      detail: { worktreeId }
    })
  )
  // Why: only a passive completed-hibernation record has a not-yet-mounted pane
  // that needs a fresh-connect cold-restore (step b). Gating on it avoids mounting
  // the worktree for non-passive records — which step (c) recovers into a fresh
  // tab — so background-mount can't strand a plain shell in the stale tab.
  if (worktreeRecords.some(isPassiveCompletedHibernationEvidence)) {
    window.dispatchEvent(
      new CustomEvent<BackgroundMountTerminalWorktreeDetail>(
        BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT,
        {
          detail: { worktreeId }
        }
      )
    )
  }
  resumeSleepingAgentSessionsForWorktree(worktreeId, { suppressNavigation: true })
}
