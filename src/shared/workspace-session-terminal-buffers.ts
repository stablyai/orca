import type { Repo, WorkspaceSessionState } from './types'
import { FLOATING_TERMINAL_WORKTREE_ID } from './constants'
import { getRepoIdFromWorktreeId } from './worktree-id'

export type RepoConnection = Pick<Repo, 'id' | 'connectionId'>

function shouldPreserveTerminalScrollbackBuffersForRepoMap(
  worktreeId: string | undefined,
  connectionIdByRepoId: ReadonlyMap<string, string | null | undefined>
): boolean {
  if (worktreeId === undefined || worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return false
  }
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const connectionId = connectionIdByRepoId.get(repoId)
  if (connectionId) {
    return true
  }
  if (!connectionIdByRepoId.has(repoId)) {
    // Why: when the repo catalog is not hydrated, treating the worktree as SSH
    // avoids losing the only scrollback source a relay-backed terminal may have.
    return true
  }
  return false
}

export function shouldPreserveTerminalScrollbackBuffers(
  worktreeId: string | undefined,
  repos: readonly RepoConnection[]
): boolean {
  return shouldPreserveTerminalScrollbackBuffersForRepoMap(
    worktreeId,
    new Map(repos.map((repo) => [repo.id, repo.connectionId] as const))
  )
}

export function pruneLocalTerminalScrollbackBuffers(
  session: WorkspaceSessionState,
  repos: readonly RepoConnection[]
): WorkspaceSessionState {
  const connectionIdByRepoId = new Map(repos.map((repo) => [repo.id, repo.connectionId] as const))
  const worktreeIdByTabId = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree)) {
    for (const tab of tabs) {
      worktreeIdByTabId.set(tab.id, worktreeId)
    }
  }

  let terminalLayoutsByTabId: WorkspaceSessionState['terminalLayoutsByTabId'] | null = null
  for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId)) {
    if (!layout.buffersByLeafId) {
      continue
    }
    const worktreeId = worktreeIdByTabId.get(tabId)
    if (shouldPreserveTerminalScrollbackBuffersForRepoMap(worktreeId, connectionIdByRepoId)) {
      continue
    }

    terminalLayoutsByTabId ??= { ...session.terminalLayoutsByTabId }
    const layoutWithoutBuffers = { ...layout }
    delete layoutWithoutBuffers.buffersByLeafId
    terminalLayoutsByTabId[tabId] = layoutWithoutBuffers
  }

  if (!terminalLayoutsByTabId) {
    return session
  }

  return {
    ...session,
    // Why: local daemon history/checkpoints are authoritative for restart
    // scrollback. Keeping renderer-captured buffers for local tabs makes every
    // persisted state write scale with old terminal output; SSH keeps them
    // because relay teardown may leave no local history to cold-restore.
    terminalLayoutsByTabId
  }
}
