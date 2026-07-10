import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { Repo, Worktree, WorkspaceSessionState } from '../../../shared/types'
import { splitWorktreeId } from '../../../shared/worktree-id'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'

type ReconciliationInput = {
  session: WorkspaceSessionState
  repos: readonly Repo[]
  worktreesByRepo: Record<string, Worktree[]>
  runtimeHostIdByWorkspaceSessionKey: Record<string, ExecutionHostId>
}

function repoHostKey(repo: Repo | undefined): string {
  return repo ? getRepoExecutionHostId(repo) : 'local'
}

function worktreeHostKey(worktree: Worktree, reposById: Map<string, Repo>): string {
  return worktree.hostId ?? repoHostKey(reposById.get(worktree.repoId))
}

function mergeCollision(left: unknown, right: unknown): unknown {
  if (Array.isArray(left) && Array.isArray(right)) {
    return [...left, ...right]
  }
  if (
    left !== null &&
    right !== null &&
    typeof left === 'object' &&
    typeof right === 'object' &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    return { ...(left as Record<string, unknown>), ...(right as Record<string, unknown>) }
  }
  return right
}

function remapSerializableValue(value: unknown, aliases: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') {
    const direct = aliases.get(value)
    if (direct) {
      return direct
    }
    for (const [oldId, newId] of aliases) {
      if (value === worktreeWorkspaceKey(oldId)) {
        return worktreeWorkspaceKey(newId)
      }
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => remapSerializableValue(entry, aliases))
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  const remapped: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    const remappedKey = aliases.get(key) ?? key
    const remappedEntry = remapSerializableValue(entry, aliases)
    remapped[remappedKey] =
      remappedKey in remapped ? mergeCollision(remapped[remappedKey], remappedEntry) : remappedEntry
  }
  return remapped
}

export function reconcileWorkspaceSessionWorktreeIds({
  session,
  repos,
  worktreesByRepo,
  runtimeHostIdByWorkspaceSessionKey
}: ReconciliationInput): WorkspaceSessionState {
  const currentWorktrees = Object.values(worktreesByRepo).flat()
  const currentIds = new Set(currentWorktrees.map((worktree) => worktree.id))
  const reposById = new Map(repos.map((repo) => [repo.id, repo]))
  const aliases = new Map<string, string>()

  for (const oldId of Object.keys(session.tabsByWorktree)) {
    if (currentIds.has(oldId)) {
      continue
    }
    const parsed = splitWorktreeId(oldId)
    if (!parsed?.worktreePath) {
      continue
    }
    const explicitHost =
      runtimeHostIdByWorkspaceSessionKey[worktreeWorkspaceKey(oldId)] ??
      runtimeHostIdByWorkspaceSessionKey[oldId]
    const oldRepo = reposById.get(parsed.repoId)
    const oldHost = explicitHost ?? (oldRepo ? repoHostKey(oldRepo) : 'local')
    const oldPath = normalizeRuntimePathForComparison(parsed.worktreePath)
    const matches = currentWorktrees.filter(
      (worktree) =>
        worktreeHostKey(worktree, reposById) === oldHost &&
        normalizeRuntimePathForComparison(worktree.path) === oldPath
    )
    if (matches.length === 1 && matches[0]?.id !== oldId) {
      aliases.set(oldId, matches[0]!.id)
    }
  }

  if (aliases.size === 0) {
    return session
  }
  // Why: daemon PTY ids merely contain the old worktree id as a prefix; only
  // exact session keys/values are remapped so the live daemon can still attach.
  const reconciled = remapSerializableValue(session, aliases) as WorkspaceSessionState
  const activeWorktreeAlias = session.activeWorktreeId
    ? aliases.get(session.activeWorktreeId)
    : undefined
  if (activeWorktreeAlias) {
    reconciled.activeRepoId =
      splitWorktreeId(activeWorktreeAlias)?.repoId ?? reconciled.activeRepoId
  }
  return reconciled
}
