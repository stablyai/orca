// An archived Orca Cloud workspace has no VM: its panes wait (sleep intent) instead of reattaching.
import { markWorktreeSleepIntent } from '@/lib/workspace/sleep/worktree-sleep-intent'
import type { CloudStatusEntry, CloudWorkspaceSnapshot } from './orca-cloud-workspace-store'

export function isArchivedEntry(entry: CloudStatusEntry | undefined): boolean {
  return entry?.status?.state === 'archived' || Boolean(entry?.status?.archive)
}

/**
 * A workspace that became archived has no VM to reattach to: its panes wait as for a sleep
 * (no reconnect, no wake, no transport) until Unarchive wakes it. One place, so every surface
 * that mounts its panes agrees, whether it was archived here, elsewhere, or before a restart.
 */
export function holdArchivedPanes(
  previous: CloudWorkspaceSnapshot,
  next: CloudWorkspaceSnapshot
): void {
  for (const [workspaceId, entry] of Object.entries(next.status)) {
    if (isArchivedEntry(entry) && !isArchivedEntry(previous.status[workspaceId])) {
      markWorktreeSleepIntent(workspaceId)
    }
  }
}
