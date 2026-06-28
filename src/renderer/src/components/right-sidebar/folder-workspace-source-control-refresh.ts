import { getConnectionId } from '@/lib/connection-context'
import { getRightSidebarWorktreeRuntimeSettings } from './file-explorer-runtime-owner'
import { refreshGitStatusForWorktree } from './git-status-refresh'
import type { GitStatusRefreshDeps } from './git-status-refresh'
import type { Repo, Worktree } from '../../../../shared/types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session'

const REFRESH_TIMEOUT_ERROR_NAME = 'FolderSourceControlRefreshTimeout'
let nextRefreshReservationToken = 1

export type FolderSourceControlRefreshCandidate = {
  worktree: Worktree
  repo: Repo
  expanded: boolean
  manual: boolean
}

export type FolderSourceControlRefreshOutcome =
  | { kind: 'loading' }
  | { kind: 'fresh' }
  | { kind: 'unavailable'; reason: 'ssh' | 'runtime' | 'folder' }
  | { kind: 'failed'; error: unknown }

export type FolderSourceControlRefreshReservations = Map<string, number>

type QueuedFolderSourceControlRefresh = {
  candidate: FolderSourceControlRefreshCandidate
  generation: number
  reservationToken: number
}

export function getFolderSourceControlRefreshCandidates({
  worktrees,
  repos,
  expandedWorktreeIds,
  manualWorktreeIds = new Set()
}: {
  worktrees: readonly Worktree[]
  repos: readonly Repo[]
  expandedWorktreeIds: ReadonlySet<string>
  manualWorktreeIds?: ReadonlySet<string>
}): FolderSourceControlRefreshCandidate[] {
  return worktrees
    .map((worktree) => {
      const repo = resolveFolderSourceControlRepo(worktree, repos)
      if (!repo) {
        return null
      }
      return {
        worktree,
        repo,
        expanded: expandedWorktreeIds.has(worktree.id),
        manual: manualWorktreeIds.has(worktree.id)
      }
    })
    .filter((candidate): candidate is FolderSourceControlRefreshCandidate => candidate !== null)
    .sort(compareFolderSourceControlRefreshCandidates)
}

export function resolveFolderSourceControlRepo(
  worktree: Worktree,
  repos: readonly Repo[]
): Repo | null {
  const matchingRepos = repos.filter((repo) => repo.id === worktree.repoId)
  if (matchingRepos.length <= 1) {
    return matchingRepos[0] ?? null
  }
  const worktreeHost = parseExecutionHostId(worktree.hostId)
  if (worktreeHost) {
    return (
      matchingRepos.find((repo) => getRepoExecutionHostId(repo) === worktreeHost.id) ??
      matchingRepos[0] ??
      null
    )
  }
  return matchingRepos[0] ?? null
}

export async function runLimitedFolderSourceControlRefreshes({
  candidates,
  deps,
  sshConnectionStates,
  inFlightWorktreeIds,
  refreshGenerationByWorktree,
  concurrency = 3,
  timeoutMs = 15_000,
  onOutcome
}: {
  candidates: readonly FolderSourceControlRefreshCandidate[]
  deps: GitStatusRefreshDeps
  sshConnectionStates: Map<string, { status?: string }>
  inFlightWorktreeIds?: FolderSourceControlRefreshReservations
  refreshGenerationByWorktree?: Map<string, number>
  concurrency?: number
  timeoutMs?: number
  onOutcome?: (worktreeId: string, outcome: FolderSourceControlRefreshOutcome) => void
}): Promise<void> {
  const queuedWorktreeIds = new Set<string>()
  const generationMap = refreshGenerationByWorktree ?? new Map<string, number>()
  const reservedWorktreeIds = inFlightWorktreeIds ?? new Map<string, number>()
  const queue: QueuedFolderSourceControlRefresh[] = []
  for (const candidate of candidates) {
    if (
      queuedWorktreeIds.has(candidate.worktree.id) ||
      reservedWorktreeIds.has(candidate.worktree.id)
    ) {
      continue
    }
    queuedWorktreeIds.add(candidate.worktree.id)
    const generation = (generationMap.get(candidate.worktree.id) ?? 0) + 1
    const reservationToken = nextRefreshReservationToken++
    generationMap.set(candidate.worktree.id, generation)
    reservedWorktreeIds.set(candidate.worktree.id, reservationToken)
    queue.push({ candidate, generation, reservationToken })
  }
  let cursor = 0
  const workerCount = Math.max(1, Math.min(concurrency, queue.length || 1))

  const runWorker = async (): Promise<void> => {
    while (cursor < queue.length) {
      const { candidate, generation, reservationToken } = queue[cursor]
      cursor += 1
      try {
        const outcome = await refreshFolderSourceControlCandidate({
          candidate,
          deps: createGenerationScopedRefreshDeps({
            deps,
            generation,
            generationMap,
            worktreeId: candidate.worktree.id
          }),
          sshConnectionStates,
          timeoutMs,
          onOutcome
        })
        if (outcome.kind === 'failed') {
          invalidateFolderSourceControlRefreshGeneration(generationMap, [candidate.worktree.id])
        }
        onOutcome?.(candidate.worktree.id, outcome)
      } finally {
        if (reservedWorktreeIds.get(candidate.worktree.id) === reservationToken) {
          reservedWorktreeIds.delete(candidate.worktree.id)
        }
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, runWorker))
}

export function invalidateFolderSourceControlRefreshGeneration(
  generationMap: Map<string, number>,
  worktreeIds: Iterable<string>
): void {
  for (const worktreeId of worktreeIds) {
    generationMap.set(worktreeId, (generationMap.get(worktreeId) ?? 0) + 1)
  }
}

function createGenerationScopedRefreshDeps({
  deps,
  generation,
  generationMap,
  worktreeId
}: {
  deps: GitStatusRefreshDeps
  generation: number
  generationMap: Map<string, number>
  worktreeId: string
}): GitStatusRefreshDeps {
  const isCurrent = () => generationMap.get(worktreeId) === generation
  return {
    setGitStatus: (targetWorktreeId, status) => {
      if (isCurrent()) {
        deps.setGitStatus(targetWorktreeId, status)
      }
    },
    updateWorktreeGitIdentity: (targetWorktreeId, identity) => {
      if (isCurrent()) {
        deps.updateWorktreeGitIdentity(targetWorktreeId, identity)
      }
    },
    setUpstreamStatus: (targetWorktreeId, status) => {
      if (isCurrent()) {
        deps.setUpstreamStatus(targetWorktreeId, status)
      }
    },
    fetchUpstreamStatus: (...args) => deps.fetchUpstreamStatus(...args)
  }
}

async function refreshFolderSourceControlCandidate({
  candidate,
  deps,
  sshConnectionStates,
  timeoutMs,
  onOutcome
}: {
  candidate: FolderSourceControlRefreshCandidate
  deps: GitStatusRefreshDeps
  sshConnectionStates: Map<string, { status?: string }>
  timeoutMs: number
  onOutcome?: (worktreeId: string, outcome: FolderSourceControlRefreshOutcome) => void
}): Promise<FolderSourceControlRefreshOutcome> {
  const { worktree, repo } = candidate
  if (isFolderRepo(repo)) {
    return { kind: 'unavailable', reason: 'folder' }
  }
  const parsedHost =
    parseExecutionHostId(worktree.hostId) ?? parseExecutionHostId(repo.executionHostId)
  if (parsedHost?.kind === 'runtime' && !isWebRuntimeSessionActive(parsedHost.environmentId)) {
    return { kind: 'unavailable', reason: 'runtime' }
  }
  const connectionId = resolveFolderSourceControlConnectionId(worktree, repo)
  if (connectionId && sshConnectionStates.get(connectionId)?.status !== 'connected') {
    return { kind: 'unavailable', reason: 'ssh' }
  }

  onOutcome?.(worktree.id, { kind: 'loading' })
  const refreshPromise = refreshGitStatusForWorktree({
    settings: getRightSidebarWorktreeRuntimeSettings(worktree.id),
    worktreeId: worktree.id,
    worktreePath: worktree.path,
    connectionId,
    pushTarget: worktree.pushTarget,
    deps
  })
  try {
    await withTimeout(refreshPromise, timeoutMs)
    return { kind: 'fresh' }
  } catch (error) {
    return { kind: 'failed', error }
  }
}

function resolveFolderSourceControlConnectionId(
  worktree: Worktree,
  repo: Repo
): string | undefined {
  const worktreeHost = parseExecutionHostId(worktree.hostId)
  if (worktreeHost?.kind === 'ssh') {
    return worktreeHost.targetId
  }
  if (worktreeHost) {
    return undefined
  }
  const repoHost = parseExecutionHostId(getRepoExecutionHostId(repo))
  if (repoHost?.kind === 'ssh') {
    return repoHost.targetId
  }
  if (repoHost) {
    return undefined
  }
  return getConnectionId(worktree.id) ?? undefined
}

function compareFolderSourceControlRefreshCandidates(
  left: FolderSourceControlRefreshCandidate,
  right: FolderSourceControlRefreshCandidate
): number {
  return (
    getRefreshPriority(left) - getRefreshPriority(right) ||
    (right.worktree.lastActivityAt ?? 0) - (left.worktree.lastActivityAt ?? 0) ||
    left.worktree.displayName.localeCompare(right.worktree.displayName)
  )
}

function getRefreshPriority(candidate: FolderSourceControlRefreshCandidate): number {
  if (candidate.manual) {
    return 0
  }
  if (candidate.expanded) {
    return 1
  }
  return 2
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      const error = new Error('Timed out refreshing source control status')
      error.name = REFRESH_TIMEOUT_ERROR_NAME
      reject(error)
    }, timeoutMs)
    promise.then(
      (value) => {
        window.clearTimeout(timeoutId)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timeoutId)
        reject(error)
      }
    )
  })
}
