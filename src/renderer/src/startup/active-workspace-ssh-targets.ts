import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'

type ActiveWorkspaceSshTargetInput = {
  activeWorktreeId: string | null
  tabsByWorktree: Readonly<Record<string, readonly { id: string; ptyId?: string | null }[]>>
  /** Restored tab-level PTY ids, keyed by tab id. */
  pendingReconnectPtyIdByTabId: Readonly<Record<string, string>>
  terminalLayoutsByTabId: Readonly<
    Record<string, { ptyIdsByLeafId?: Readonly<Record<string, string | null>> } | undefined>
  >
  repos: readonly { id: string; connectionId?: string | null }[]
}

/**
 * SSH targets that own terminals the user sees the moment the startup gate opens: the ones
 * whose reconnect must still be awaited. Everything else can connect in the background and
 * reattach on tab focus.
 *
 * Derived from the restored PTY ids rather than the repo catalog alone, because SSH worktrees
 * are absent from `worktreesByRepo` at cold start — the PTY id is the durable name of the
 * target the pane will reattach.
 */
export function collectActiveWorkspaceSshTargetIds(input: ActiveWorkspaceSshTargetInput): string[] {
  const { activeWorktreeId } = input
  if (!activeWorktreeId) {
    return []
  }
  const targetIds = new Set<string>()
  const repoId = getRepoIdFromWorktreeId(activeWorktreeId)
  const connectionId = input.repos.find((repo) => repo.id === repoId)?.connectionId
  if (connectionId) {
    targetIds.add(connectionId)
  }
  for (const tab of input.tabsByWorktree[activeWorktreeId] ?? []) {
    const ptyIds = [
      tab.ptyId,
      input.pendingReconnectPtyIdByTabId[tab.id],
      ...Object.values(input.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {})
    ]
    for (const ptyId of ptyIds) {
      const parsed = ptyId ? parseAppSshPtyId(ptyId) : null
      if (parsed) {
        targetIds.add(parsed.connectionId)
      }
    }
  }
  return [...targetIds]
}
