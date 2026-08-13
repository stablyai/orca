import { defaultFilter } from 'cmdk'
import {
  getWorktreeExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { WORKTREE_CREATE_PARENT_AUTHORITY_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { Repo, Worktree } from '../../../../shared/types'

type ChildWorktreeParentCandidateArgs = {
  worktrees: readonly Worktree[]
  repoId: string
  projectId: string | null
  executionHostId: ExecutionHostId
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>
}

export type ChildWorktreeParentSection = {
  key: 'recent' | 'all' | 'results'
  items: Worktree[]
}

const RECENT_LIMIT = 4
const MAX_QUERY_LENGTH = 2_048

export function shouldShowChildWorktreeParentField(
  isProjectGroupTarget: boolean,
  selectedRepoIsGit: boolean,
  hasEphemeralVmTarget: boolean
): boolean {
  return !isProjectGroupTarget && selectedRepoIsGit && !hasEphemeralVmTarget
}

export function supportsChildWorktreeParentSelection(
  executionHostId: ExecutionHostId | null,
  runtimeCapabilities: readonly string[] | null | undefined
): boolean {
  const host = parseExecutionHostId(executionHostId)
  return (
    host?.kind !== 'runtime' ||
    runtimeCapabilities?.includes(WORKTREE_CREATE_PARENT_AUTHORITY_RUNTIME_CAPABILITY) === true
  )
}

function getCandidateRuntimeHostId(candidate: Worktree): ExecutionHostId | null {
  const environmentId = candidate.runtimeOwnerEnvironmentId?.trim()
  return environmentId ? toRuntimeExecutionHostId(environmentId) : null
}

function candidateBelongsToTargetHost(
  candidate: Worktree,
  executionHostId: ExecutionHostId,
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>
): boolean {
  const runtimeHostId = getCandidateRuntimeHostId(candidate)
  if (parseExecutionHostId(executionHostId)?.kind === 'runtime') {
    const connectionId = repo.connectionId?.trim()
    const physicalHostId = connectionId
      ? toSshExecutionHostId(connectionId)
      : LOCAL_EXECUTION_HOST_ID
    return (
      runtimeHostId === executionHostId &&
      getWorktreeExecutionHostId(candidate, undefined) === physicalHostId
    )
  }
  return runtimeHostId === null && getWorktreeExecutionHostId(candidate, repo) === executionHostId
}

function candidateMatchesActiveHost(
  candidate: Worktree,
  activeExecutionHostId: ExecutionHostId,
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>
): boolean {
  return (
    getWorktreeExecutionHostId(candidate, repo) === activeExecutionHostId ||
    getCandidateRuntimeHostId(candidate) === activeExecutionHostId
  )
}

export function getChildWorktreeParentCandidates({
  worktrees,
  repoId,
  projectId,
  executionHostId,
  repo
}: ChildWorktreeParentCandidateArgs): Worktree[] {
  return worktrees.filter(
    (candidate) =>
      candidate.repoId === repoId &&
      !candidate.isArchived &&
      candidateBelongsToTargetHost(candidate, executionHostId, repo) &&
      (projectId === null || candidate.projectId === undefined || candidate.projectId === projectId)
  )
}

function compareParentRecency(
  a: Worktree,
  b: Worktree,
  lastVisitedAtByWorktreeId: Readonly<Record<string, number>>
): number {
  const aVisited = lastVisitedAtByWorktreeId[a.id]
  const bVisited = lastVisitedAtByWorktreeId[b.id]
  if (aVisited !== undefined && bVisited !== undefined && aVisited !== bVisited) {
    return bVisited - aVisited
  }
  if (aVisited !== undefined) {
    return -1
  }
  if (bVisited !== undefined) {
    return 1
  }
  return (
    b.lastActivityAt - a.lastActivityAt ||
    (a.displayName ?? '').localeCompare(b.displayName ?? '') ||
    a.path.localeCompare(b.path)
  )
}

function searchableParentText(candidate: Worktree): string {
  return `${candidate.displayName ?? ''} ${candidate.branch.replace(/^refs\/heads\//, '')} ${candidate.path}`
}

export function rankChildWorktreeParentCandidates(
  candidates: readonly Worktree[],
  rawQuery: string,
  lastVisitedAtByWorktreeId: Readonly<Record<string, number>>
): Worktree[] {
  if (rawQuery.length > MAX_QUERY_LENGTH) {
    return []
  }
  const query = rawQuery.trim()
  if (!query) {
    return [...candidates].sort((a, b) => compareParentRecency(a, b, lastVisitedAtByWorktreeId))
  }
  return candidates
    .map((candidate) => ({
      candidate,
      score: defaultFilter(searchableParentText(candidate), query, [])
    }))
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        compareParentRecency(a.candidate, b.candidate, lastVisitedAtByWorktreeId)
    )
    .map(({ candidate }) => candidate)
}

export function sectionChildWorktreeParentCandidates(
  ranked: readonly Worktree[],
  query: string
): ChildWorktreeParentSection[] {
  if (query.trim()) {
    return [{ key: 'results', items: [...ranked] }]
  }
  const recent = ranked.slice(0, RECENT_LIMIT)
  const remaining = ranked.slice(RECENT_LIMIT)
  return [
    ...(recent.length > 0 ? [{ key: 'recent' as const, items: recent }] : []),
    ...(remaining.length > 0 ? [{ key: 'all' as const, items: remaining }] : [])
  ]
}

export function resolvePreferredChildWorktreeParentId(
  currentId: string | null,
  orderedCandidates: readonly Worktree[],
  activeWorktreeId: string | null
): string | null {
  if (currentId && orderedCandidates.some((candidate) => candidate.id === currentId)) {
    return currentId
  }
  if (
    activeWorktreeId &&
    orderedCandidates.some((candidate) => candidate.id === activeWorktreeId)
  ) {
    return activeWorktreeId
  }
  return orderedCandidates[0]?.id ?? null
}

export function getDefaultChildWorktreeParentId(
  candidates: readonly Worktree[],
  activeWorktreeId: string | null,
  activeExecutionHostId: ExecutionHostId | null,
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>
): string | null {
  return activeWorktreeId &&
    activeExecutionHostId &&
    candidates.some(
      (candidate) =>
        candidate.id === activeWorktreeId &&
        candidateMatchesActiveHost(candidate, activeExecutionHostId, repo)
    )
    ? activeWorktreeId
    : null
}

export function resolveChildWorktreeCreateParentId(
  touched: boolean,
  enabled: boolean,
  selectedParentId: string | null
): string | null | undefined {
  if (enabled && selectedParentId) {
    return selectedParentId
  }
  return touched ? null : undefined
}
