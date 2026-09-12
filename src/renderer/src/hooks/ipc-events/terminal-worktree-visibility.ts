import {
  hasRenderableTerminalWorktreeSurface as hasTerminalWorktreeRow,
  resolveTerminalWorktreeCatalogHostId
} from '@/lib/terminal-worktree-route'
import { importNewExternalWorktreeInboxPaths } from '@/components/sidebar/new-external-worktrees-inbox-actions'
import { findRepoForHost, getRepoHostIdentity } from '@/store/slices/repo-host-identity'
import { getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'
import {
  worktreeHostMatchOptions,
  worktreeMatchesHost
} from '@/store/slices/worktrees/listing/worktree-host-ownership'
import { useAppStore } from '../../store'

const pendingImports = new Map<string, Promise<void>>()

export { hasRenderableTerminalWorktreeSurface as hasTerminalWorktreeRow } from '@/lib/terminal-worktree-route'

export function hiddenTerminalWorktreeError(): Error {
  return new Error('worktree_hidden: Terminal workspace could not be shown in the sidebar')
}

export async function ensureTerminalWorktreeVisible(worktreeId: string): Promise<void> {
  const state = useAppStore.getState()
  if (hasTerminalWorktreeRow(state, worktreeId)) {
    return
  }
  const hostId = resolveTerminalWorktreeCatalogHostId(state, worktreeId)
  if (!hostId) {
    throw hiddenTerminalWorktreeError()
  }
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const repo = findRepoForHost(state.repos, repoId, { hostId })
  if (!repo) {
    throw hiddenTerminalWorktreeError()
  }
  const scope = getRepoHostIdentity(repo)
  // Why: concurrent reveals must merge imports against the preceding persisted update.
  const previous = pendingImports.get(scope) ?? Promise.resolve()
  const pending = previous
    .catch(() => {})
    .then(async () => {
      const current = useAppStore.getState()
      if (hasTerminalWorktreeRow(current, worktreeId)) {
        return
      }
      const targetRepo = findRepoForHost(current.repos, repoId, { hostId })
      const detected = current.detectedWorktreesByRepo[repoId]?.worktrees.filter(
        (worktree) =>
          worktree.id === worktreeId &&
          worktreeMatchesHost(worktree, hostId, worktreeHostMatchOptions(current, repoId, hostId))
      )
      if (!targetRepo || detected?.length !== 1 || detected[0].visible) {
        throw hiddenTerminalWorktreeError()
      }
      const imported = await importNewExternalWorktreeInboxPaths({
        projectId: repoId,
        repo: targetRepo,
        worktreePaths: [detected[0].path],
        updateRepo: (id, updates) => current.updateRepo(id, updates, { hostId }),
        fetchWorktrees: (id, options) =>
          current.fetchWorktrees(id, { ...options, executionHostId: hostId }),
        setInboxState: () => {}
      })
      if (!imported || !hasTerminalWorktreeRow(useAppStore.getState(), worktreeId)) {
        throw hiddenTerminalWorktreeError()
      }
    })
  pendingImports.set(scope, pending)
  try {
    await pending
  } finally {
    if (pendingImports.get(scope) === pending) {
      pendingImports.delete(scope)
    }
  }
}
