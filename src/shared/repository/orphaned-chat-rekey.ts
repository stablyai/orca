import { normalizeRuntimePathForComparison } from '../file-access/cross-platform-path'
import { getRepoExecutionHostId } from '../execution-host/execution-host'
import type { Repo } from './repo-types'
import {
  composeWorktreeId,
  FOLDER_WORKSPACE_INSTANCE_SEPARATOR,
  splitWorktreeId
} from '../worktree/id'

/** What a removed project leaves behind so a later re-add of the same project can find its chats. */
export type RemovedProjectTombstone = {
  repoId: string
  path: string
  kind: 'git' | 'folder'
  executionHostId: string
  /** Git: root commit(s); folder: filesystem identity. Null when it could not be read: never matches. */
  identity: string | null
  /** Chats that had an open tab when the project was removed, in tab order (the removal closes them). */
  openSessionIds?: readonly string[]
}

export type ChatLocationView = {
  sessionId: string
  location: { executionHostId: string; workspaceId: string }
}

export type OrphanedChatRekey = { sessionId: string; from: string; to: string }

/**
 * Chats of a removed project to move onto the re-added project's NEW repo id (stablyai/orca#40409).
 * The new project never takes the old id, so automations and other id-keyed state stay with the old,
 * removed id. A tombstone matches only on the same host, same kind, same path and the same identity
 * (a different repository or a recreated folder at the same path inherits nothing). Chats saved under
 * the project root or one of its folder instances move to the new root workspace id (instance metadata
 * is deleted with the project); chats of other worktrees of the same git repo keep their path.
 */
export function planOrphanedChatRekeys(
  conversations: Iterable<ChatLocationView>,
  tombstones: readonly RemovedProjectTombstone[],
  repo: Pick<Repo, 'id' | 'path' | 'kind' | 'executionHostId' | 'connectionId'>,
  identity: string | null
): OrphanedChatRekey[] {
  if (identity === null) {
    return []
  }
  const hostId = getRepoExecutionHostId(repo)
  const wanted = normalizeRuntimePathForComparison(repo.path)
  const kind = repo.kind ?? 'git'
  const oldIds = new Set(
    tombstones
      .filter(
        (tombstone) =>
          tombstone.repoId !== repo.id &&
          tombstone.identity === identity &&
          tombstone.kind === kind &&
          tombstone.executionHostId === hostId &&
          normalizeRuntimePathForComparison(tombstone.path) === wanted
      )
      .map((tombstone) => tombstone.repoId)
  )
  if (oldIds.size === 0) {
    return []
  }
  const rootId = composeWorktreeId(repo.id, repo.path)
  const moves: OrphanedChatRekey[] = []
  for (const { sessionId, location } of conversations) {
    if (location.executionHostId !== hostId) {
      continue
    }
    const parsed = splitWorktreeId(location.workspaceId)
    if (!parsed || !oldIds.has(parsed.repoId)) {
      continue
    }
    const basePath = parsed.worktreePath.split(FOLDER_WORKSPACE_INSTANCE_SEPARATOR)[0]
    if (!basePath) {
      continue
    }
    if (normalizeRuntimePathForComparison(basePath) === wanted) {
      moves.push({ sessionId, from: location.workspaceId, to: rootId })
    } else if (kind === 'git' && parsed.worktreePath === basePath) {
      moves.push({
        sessionId,
        from: location.workspaceId,
        to: composeWorktreeId(repo.id, parsed.worktreePath)
      })
    }
  }
  return moves
}
