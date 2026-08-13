import type { useAppStore } from '@/store'
import {
  type ExecutionHostId,
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getExecutionHostIdForWorktree } from './worktree-runtime-owner'

const OWNER_ERROR = 'The target workspace host is unavailable or ambiguous.'

type AgentSessionWorkspaceOwnerStore = ReturnType<typeof useAppStore.getState>
type Worktree = ReturnType<AgentSessionWorkspaceOwnerStore['allWorktrees']>[number]
type Repo = AgentSessionWorkspaceOwnerStore['repos'][number]

export type AgentSessionWorkspaceOwner = {
  executionHostId: ExecutionHostId
  worktree: Worktree
  repo: Repo | null
}

export function hasAgentSessionWorkspaceMetadata(
  store: AgentSessionWorkspaceOwnerStore,
  worktreeId: string
): boolean {
  if (parseWorkspaceKey(worktreeId)?.type === 'folder') {
    return true
  }
  return [
    ...(typeof store.allWorktrees === 'function' ? store.allWorktrees() : []),
    ...Object.values(store.worktreesByRepo ?? {}).flat(),
    ...Object.values(store.detectedWorktreesByRepo ?? {}).flatMap((entry) => entry?.worktrees ?? [])
  ].some((worktree) => worktree.id === worktreeId)
}

function failOwnerResolution(): never {
  throw new Error(OWNER_ERROR)
}

function getWorktreeHostId(worktree: Worktree): ExecutionHostId {
  return worktree.hostId ?? LOCAL_EXECUTION_HOST_ID
}

export function resolveAgentSessionWorkspaceOwner(
  store: AgentSessionWorkspaceOwnerStore,
  worktreeId: string,
  expectedExecutionHostId?: ExecutionHostId,
  options?: { allowLegacyExpectedOwner?: boolean }
): AgentSessionWorkspaceOwner {
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    const folderExecutionHostId = getExecutionHostIdForWorktree(store, worktreeId)
    if (expectedExecutionHostId && expectedExecutionHostId !== folderExecutionHostId) {
      failOwnerResolution()
    }
    const worktree = store.getKnownWorktreeById(worktreeId, folderExecutionHostId)
    if (!worktree || getWorktreeHostId(worktree) !== folderExecutionHostId) {
      failOwnerResolution()
    }
    return { executionHostId: folderExecutionHostId, worktree, repo: null }
  }

  const candidates = [
    ...(typeof store.allWorktrees === 'function' ? store.allWorktrees() : []),
    ...Object.values(store.worktreesByRepo ?? {}).flat(),
    ...Object.values(store.detectedWorktreesByRepo ?? {}).flatMap((entry) => entry?.worktrees ?? [])
  ].filter((worktree) => worktree.id === worktreeId)
  const resolveCandidateHostId = (worktree: Worktree): ExecutionHostId => {
    if (
      options?.allowLegacyExpectedOwner &&
      expectedExecutionHostId &&
      (!worktree.hostId || worktree.hostId === LOCAL_EXECUTION_HOST_ID)
    ) {
      return expectedExecutionHostId
    }
    return getWorktreeHostId(worktree)
  }
  const owners = new Map<string, { executionHostId: ExecutionHostId; repoId: string }>()
  for (const worktree of candidates) {
    const executionHostId = resolveCandidateHostId(worktree)
    if (expectedExecutionHostId && executionHostId !== expectedExecutionHostId) {
      continue
    }
    owners.set(`${executionHostId}\u0000${worktree.repoId}`, {
      executionHostId,
      repoId: worktree.repoId
    })
  }
  if (owners.size !== 1) {
    failOwnerResolution()
  }

  const owner = [...owners.values()][0]
  const knownWorktree =
    typeof store.getKnownWorktreeById === 'function'
      ? store.getKnownWorktreeById(worktreeId, owner.executionHostId)
      : null
  const worktree =
    knownWorktree?.repoId === owner.repoId &&
    resolveCandidateHostId(knownWorktree) === owner.executionHostId
      ? knownWorktree
      : candidates.find(
          (candidate) =>
            candidate.repoId === owner.repoId &&
            resolveCandidateHostId(candidate) === owner.executionHostId
        )
  if (!worktree || resolveCandidateHostId(worktree) !== owner.executionHostId) {
    failOwnerResolution()
  }

  const exactRepos = store.repos.filter(
    (repo) => repo.id === owner.repoId && getRepoExecutionHostId(repo) === owner.executionHostId
  )
  const legacyRepos =
    options?.allowLegacyExpectedOwner && expectedExecutionHostId
      ? store.repos.filter(
          (repo) => repo.id === owner.repoId && !repo.executionHostId && !repo.connectionId
        )
      : []
  const repos = exactRepos.length > 0 ? exactRepos : legacyRepos
  if (repos.length !== 1) {
    failOwnerResolution()
  }
  return { executionHostId: owner.executionHostId, worktree, repo: repos[0] }
}
