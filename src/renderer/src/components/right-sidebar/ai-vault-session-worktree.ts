import { useMemo } from 'react'
import {
  normalizedWslPathCandidateAliases,
  wslAliasedPathDepth,
  wslRootPathAliases
} from '../../../../shared/wsl-path-aliases'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import {
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison
} from '../../../../shared/cross-platform-path'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { aiVaultWorktreeCompactPath } from './ai-vault-session-worktree-affordances'

export {
  aiVaultWorktreeCompactPath,
  aiVaultWorktreeJumpTooltip,
  aiVaultWorktreeStatusLabel,
  canJumpToAiVaultSessionWorktree,
  isAiVaultSessionInCurrentWorktree,
  shouldShowAiVaultSessionWorktreeLine,
  shouldShowAiVaultWorktreeStatusBadge
} from './ai-vault-session-worktree-affordances'

export type AiVaultSessionWorktreeStatus = 'current' | 'active' | 'archived' | 'unavailable'

export type AiVaultSessionWorktreeInfo = {
  status: AiVaultSessionWorktreeStatus
  label: string
  path: string
  worktreeId?: string
}

type WorktreeCandidate = {
  worktree: Worktree
  path: string
  hostId: ExecutionHostId
  status: Exclude<AiVaultSessionWorktreeStatus, 'current'>
  source: 'current-path' | 'prior-path'
  pathDepth: number
  order: number
}

type WorktreeCandidateLookup = {
  candidatesByRoot: ReadonlyMap<string, readonly WorktreeCandidate[]>
}

export function resolveAiVaultSessionWorktreeInfo({
  session,
  repos = [],
  worktrees,
  activeWorktreeId
}: {
  session: AiVaultSession
  repos?: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
  worktrees: readonly Worktree[]
  activeWorktreeId: string | null
}): AiVaultSessionWorktreeInfo | null {
  return withAiVaultCurrentWorktreeStatus(
    resolveWorktreeInfoFromCandidates(session, buildWorktreeCandidateLookup(worktrees, repos)),
    activeWorktreeId
  )
}

/**
 * Stamps `status: 'current'` at read time so the session→worktree map itself
 * never depends on the active worktree — switching worktrees must not rebuild it.
 */
export function withAiVaultCurrentWorktreeStatus(
  worktreeInfo: AiVaultSessionWorktreeInfo | null,
  activeWorktreeId: string | null
): AiVaultSessionWorktreeInfo | null {
  if (!worktreeInfo?.worktreeId || worktreeInfo.worktreeId !== activeWorktreeId) {
    return worktreeInfo
  }
  return worktreeInfo.status === 'current' ? worktreeInfo : { ...worktreeInfo, status: 'current' }
}

function resolveWorktreeInfoFromCandidates(
  session: AiVaultSession,
  lookup: WorktreeCandidateLookup
): AiVaultSessionWorktreeInfo | null {
  if (!session.cwd) {
    return null
  }

  const sessionHostId = normalizeExecutionHostId(session.executionHostId)
  const cwdAliases = normalizedWslPathCandidateAliases(session.cwd)
  const best = findBestWorktreeCandidate(lookup, sessionHostId, cwdAliases)
  if (!best) {
    return {
      status: 'unavailable',
      label: compactPathLabel(session.cwd),
      path: session.cwd
    }
  }

  return {
    status: best.status,
    label: best.worktree.displayName || compactPathLabel(best.path),
    path: best.path,
    worktreeId: best.worktree.id
  }
}

function findBestWorktreeCandidate(
  lookup: WorktreeCandidateLookup,
  sessionHostId: ExecutionHostId | null,
  normalizedCwdAliases: readonly string[]
): WorktreeCandidate | null {
  let best: WorktreeCandidate | null = null
  for (const cwdAlias of normalizedCwdAliases) {
    let ancestorPath = cwdAlias
    while (ancestorPath) {
      const matchingCandidates = lookup.candidatesByRoot.get(ancestorPath)
      if (matchingCandidates) {
        for (const candidate of matchingCandidates) {
          if (sessionHostId && candidate.hostId !== sessionHostId) {
            continue
          }
          if (!best || compareWorktreeCandidates(candidate, best) < 0) {
            best = candidate
          }
        }
      }
      if (ancestorPath === '/' || /^[a-z]:\/$/i.test(ancestorPath)) {
        break
      }
      const separatorIndex = ancestorPath.lastIndexOf('/')
      if (separatorIndex === -1) {
        break
      }
      if (separatorIndex === 0) {
        ancestorPath = '/'
      } else if (separatorIndex === 2 && /^[a-z]:\//i.test(ancestorPath)) {
        ancestorPath = ancestorPath.slice(0, 3)
      } else {
        ancestorPath = ancestorPath.slice(0, separatorIndex)
      }
    }
  }
  return best
}

export function extractWorktreePathFromSessionTitle(title: string): string | null {
  const trimmed = title.trim()
  if (!trimmed) {
    return null
  }

  const suffixMatch = trimmed.match(/\s-\s*Worktree:\s*(.+)$/i)
  if (suffixMatch?.[1]) {
    return suffixMatch[1].trim()
  }

  const inlineMatch = trimmed.match(/\bWorktree:\s*(.+)$/i)
  return inlineMatch?.[1]?.trim() ?? null
}

export function resolveAiVaultSessionWorktreeDisplay(args: {
  session: AiVaultSession
  repos?: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
  worktrees: readonly Worktree[]
  activeWorktreeId: string | null
}): AiVaultSessionWorktreeInfo | null {
  return withAiVaultCurrentWorktreeStatus(
    resolveWorktreeDisplayFromCandidates(
      args.session,
      buildWorktreeCandidateLookup(args.worktrees, args.repos ?? [])
    ),
    args.activeWorktreeId
  )
}

function resolveWorktreeDisplayFromCandidates(
  session: AiVaultSession,
  lookup: WorktreeCandidateLookup
): AiVaultSessionWorktreeInfo | null {
  const resolved = resolveWorktreeInfoFromCandidates(session, lookup)
  if (resolved) {
    return resolved
  }

  const cwd = session.cwd?.trim()
  if (cwd) {
    return unavailableWorktreeInfo(cwd)
  }

  const titlePath = extractWorktreePathFromSessionTitle(session.title)
  if (titlePath) {
    return unavailableWorktreeInfo(titlePath)
  }

  const branch = session.branch?.trim()
  if (branch) {
    return {
      status: 'unavailable',
      label: branch,
      path: branch
    }
  }

  return null
}

/**
 * Deliberately unaware of the active worktree: stamping `current` here would
 * rebuild the whole map (candidates × sessions) on every worktree switch.
 * Callers derive it per row via `withAiVaultCurrentWorktreeStatus`.
 */
export function useAiVaultSessionWorktreeMap({
  sessions,
  repos = [],
  worktrees
}: {
  sessions: readonly AiVaultSession[]
  repos?: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
  worktrees: readonly Worktree[]
}): ReadonlyMap<string, AiVaultSessionWorktreeInfo> {
  return useMemo(() => {
    // Hoisted out of the per-session loop: candidates and their normalized
    // roots are session-independent.
    const lookup = buildWorktreeCandidateLookup(worktrees, repos)
    const worktreeInfoBySessionId = new Map<string, AiVaultSessionWorktreeInfo>()
    for (const session of sessions) {
      const worktreeInfo = resolveWorktreeDisplayFromCandidates(session, lookup)
      if (worktreeInfo) {
        worktreeInfoBySessionId.set(session.id, worktreeInfo)
      }
    }
    return worktreeInfoBySessionId
  }, [repos, sessions, worktrees])
}

function buildWorktreeCandidateLookup(
  worktrees: readonly Worktree[],
  repos: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
): WorktreeCandidateLookup {
  const candidates: WorktreeCandidate[] = []
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  for (const worktree of worktrees) {
    const repo = repoById.get(worktree.repoId)
    const hostId =
      normalizeExecutionHostId(worktree.hostId) ??
      (repo ? getRepoExecutionHostId(repo) : LOCAL_EXECUTION_HOST_ID)
    if (hasUsablePath(worktree.path)) {
      candidates.push(
        makeWorktreeCandidate(worktree, worktree.path, hostId, 'current-path', candidates.length)
      )
    }
    for (const priorWorktreeId of worktree.priorWorktreeIds ?? []) {
      const parsed = splitWorktreeIdForFilesystem(priorWorktreeId)
      if (!parsed || parsed.repoId !== worktree.repoId || !hasUsablePath(parsed.worktreePath)) {
        continue
      }
      candidates.push(
        makeWorktreeCandidate(
          worktree,
          parsed.worktreePath,
          hostId,
          'prior-path',
          candidates.length
        )
      )
    }
  }
  const candidatesByRoot = new Map<string, WorktreeCandidate[]>()
  for (const candidate of candidates) {
    for (const alias of wslRootPathAliases(candidate.path)) {
      const normalizedRoot = normalizeRuntimePathForComparison(alias)
      const matchingCandidates = candidatesByRoot.get(normalizedRoot)
      if (matchingCandidates) {
        matchingCandidates.push(candidate)
      } else {
        candidatesByRoot.set(normalizedRoot, [candidate])
      }
    }
  }
  return { candidatesByRoot }
}

function makeWorktreeCandidate(
  worktree: Worktree,
  path: string,
  hostId: ExecutionHostId,
  source: WorktreeCandidate['source'],
  order: number
): WorktreeCandidate {
  return {
    worktree,
    path,
    hostId,
    status: worktree.isArchived ? 'archived' : 'active',
    source,
    pathDepth: wslAliasedPathDepth(path),
    order
  }
}

function hasUsablePath(pathValue: string): boolean {
  const trimmed = pathValue.trim()
  return Boolean(trimmed && isRuntimePathAbsolute(trimmed))
}

function compareWorktreeCandidates(left: WorktreeCandidate, right: WorktreeCandidate): number {
  const depthDifference = right.pathDepth - left.pathDepth
  if (depthDifference !== 0) {
    return depthDifference
  }
  if (left.source === right.source) {
    return left.order - right.order
  }
  return left.source === 'current-path' ? -1 : 1
}

function unavailableWorktreeInfo(pathValue: string): AiVaultSessionWorktreeInfo {
  return {
    status: 'unavailable',
    label: compactPathLabel(pathValue),
    path: pathValue
  }
}

function compactPathLabel(pathValue: string): string {
  return aiVaultWorktreeCompactPath(pathValue)
}
