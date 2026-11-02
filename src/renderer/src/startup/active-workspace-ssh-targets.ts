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

/** Await reconnect only for hosts whose panes mount when startup opens; others reconnect in background/on focus. Derive owners from restored PTY IDs because cold SSH worktrees are absent from the repo catalog. */
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
