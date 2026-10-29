// Which live workspace owns a saved session's cwd, on the host that recorded it; shared by desktop and mobile.

import { parseWslUncPath } from './wsl-paths'
import { splitWorktreeIdForFilesystem } from './worktree/id'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import {
  createNormalizedPathInsideOrEqualMatcher,
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison,
  normalizeRuntimePathSeparators
} from './cross-platform-path'
import type { AiVaultSession } from './ai-vault-types'
import type { Worktree } from './worktree/types'

/** The workspace fields that decide ownership; folder workspaces pass their folder row. */
export type AiVaultSessionOwnerWorkspace = Pick<
  Worktree,
  'id' | 'path' | 'repoId' | 'displayName'
> &
  Partial<Pick<Worktree, 'hostId' | 'isArchived' | 'priorWorktreeIds'>>

export type AiVaultSessionOwnerRepo = {
  id: string
  connectionId?: string | null
  executionHostId?: string | null
}

export type AiVaultSessionWorktreeStatus = 'current' | 'active' | 'archived' | 'unavailable'

export type AiVaultSessionWorktreeInfo = {
  status: AiVaultSessionWorktreeStatus
  label: string
  path: string
  worktreeId?: string
}

type WorktreeCandidate = {
  worktree: AiVaultSessionOwnerWorkspace
  path: string
  hostId: ExecutionHostId
  status: Exclude<AiVaultSessionWorktreeStatus, 'current'>
  source: 'current-path' | 'prior-path'
  // Precomputed so a 500-session scan doesn't re-normalize ~500 roots per session.
  ownsNormalizedCwd: (normalizedCwd: string) => boolean
  normalizedPathLength: number
}

export function resolveAiVaultSessionWorktreeInfo({
  session,
  repos = [],
  worktrees,
  activeWorktreeId
}: {
  session: AiVaultSession
  repos?: readonly AiVaultSessionOwnerRepo[]
  worktrees: readonly AiVaultSessionOwnerWorkspace[]
  activeWorktreeId: string | null
}): AiVaultSessionWorktreeInfo | null {
  return withAiVaultCurrentWorktreeStatus(
    resolveWorktreeInfoFromCandidates(session, buildWorktreeCandidates(worktrees, repos)),
    activeWorktreeId
  )
}

/** Stamp current at read time so workspace switches do not rebuild the session map. */
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
  candidates: readonly WorktreeCandidate[]
): AiVaultSessionWorktreeInfo | null {
  if (!session.cwd) {
    return null
  }

  const sessionHostId = normalizeExecutionHostId(session.executionHostId)
  const normalizedCwd = normalizeRuntimePathForComparison(session.cwd)
  const matched = candidates
    .filter((candidate) => candidate.ownsNormalizedCwd(normalizedCwd))
    .filter((candidate) => !sessionHostId || candidate.hostId === sessionHostId)
    .sort(compareWorktreeCandidates)

  const best = matched[0]
  if (!best) {
    return {
      status: 'unavailable',
      label: aiVaultWorktreeCompactPath(session.cwd),
      path: session.cwd
    }
  }

  return {
    status: best.status,
    label: best.worktree.displayName || aiVaultWorktreeCompactPath(best.path),
    path: best.path,
    worktreeId: best.worktree.id
  }
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
  repos?: readonly AiVaultSessionOwnerRepo[]
  worktrees: readonly AiVaultSessionOwnerWorkspace[]
  activeWorktreeId: string | null
}): AiVaultSessionWorktreeInfo | null {
  return withAiVaultCurrentWorktreeStatus(
    resolveWorktreeDisplayFromCandidates(
      args.session,
      buildWorktreeCandidates(args.worktrees, args.repos ?? [])
    ),
    args.activeWorktreeId
  )
}

function resolveWorktreeDisplayFromCandidates(
  session: AiVaultSession,
  candidates: readonly WorktreeCandidate[]
): AiVaultSessionWorktreeInfo | null {
  const resolved = resolveWorktreeInfoFromCandidates(session, candidates)
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

/** Session id to owning workspace, without the active-worktree stamp so workspace switches reuse it. */
export function buildAiVaultSessionWorktreeMap(args: {
  sessions: readonly AiVaultSession[]
  repos: readonly AiVaultSessionOwnerRepo[]
  worktrees: readonly AiVaultSessionOwnerWorkspace[]
}): ReadonlyMap<string, AiVaultSessionWorktreeInfo> {
  // Build session-independent candidates and normalized roots once.
  const candidates = buildWorktreeCandidates(args.worktrees, args.repos)
  return new Map(
    args.sessions.flatMap((session) => {
      const worktreeInfo = resolveWorktreeDisplayFromCandidates(session, candidates)
      return worktreeInfo ? [[session.id, worktreeInfo] as const] : []
    })
  )
}

export function canJumpToAiVaultSessionWorktree(
  worktreeInfo: AiVaultSessionWorktreeInfo | null
): boolean {
  return Boolean(
    worktreeInfo?.worktreeId &&
    worktreeInfo.status !== 'archived' &&
    worktreeInfo.status !== 'unavailable'
  )
}

export function aiVaultWorktreeCompactPath(pathValue: string): string {
  const parts = normalizeRuntimePathSeparators(pathValue).split('/').filter(Boolean)
  if (parts.length >= 2) {
    return parts.slice(-2).join('/')
  }
  return parts[0] ?? pathValue
}

function buildWorktreeCandidates(
  worktrees: readonly AiVaultSessionOwnerWorkspace[],
  repos: readonly AiVaultSessionOwnerRepo[]
): WorktreeCandidate[] {
  const candidates: WorktreeCandidate[] = []
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  for (const worktree of worktrees) {
    const repo = repoById.get(worktree.repoId)
    const hostId =
      normalizeExecutionHostId(worktree.hostId) ??
      (repo ? getRepoExecutionHostId(repo) : LOCAL_EXECUTION_HOST_ID)
    if (hasUsablePath(worktree.path)) {
      candidates.push(makeWorktreeCandidate(worktree, worktree.path, hostId, 'current-path'))
    }
    for (const priorWorktreeId of worktree.priorWorktreeIds ?? []) {
      const parsed = splitWorktreeIdForFilesystem(priorWorktreeId)
      if (!parsed || parsed.repoId !== worktree.repoId || !hasUsablePath(parsed.worktreePath)) {
        continue
      }
      candidates.push(makeWorktreeCandidate(worktree, parsed.worktreePath, hostId, 'prior-path'))
    }
  }
  return candidates
}

function makeWorktreeCandidate(
  worktree: AiVaultSessionOwnerWorkspace,
  path: string,
  hostId: ExecutionHostId,
  source: WorktreeCandidate['source']
): WorktreeCandidate {
  const ownsCwd = createNormalizedPathInsideOrEqualMatcher(path)
  // A WSL UNC root also owns sessions recorded under its Linux-native cwd.
  const wslPath = parseWslUncPath(path)
  const ownsCwdViaWslAlias = wslPath
    ? createNormalizedPathInsideOrEqualMatcher(wslPath.linuxPath)
    : null
  return {
    worktree,
    path,
    hostId,
    status: worktree.isArchived ? 'archived' : 'active',
    source,
    ownsNormalizedCwd: (normalizedCwd) =>
      ownsCwd(normalizedCwd) || (ownsCwdViaWslAlias?.(normalizedCwd) ?? false),
    normalizedPathLength: normalizeRuntimePathForComparison(path).length
  }
}

function hasUsablePath(pathValue: string): boolean {
  const trimmed = pathValue.trim()
  return Boolean(trimmed && isRuntimePathAbsolute(trimmed))
}

function compareWorktreeCandidates(left: WorktreeCandidate, right: WorktreeCandidate): number {
  const lengthDifference = right.normalizedPathLength - left.normalizedPathLength
  if (lengthDifference !== 0) {
    return lengthDifference
  }
  if (left.source === right.source) {
    return 0
  }
  return left.source === 'current-path' ? -1 : 1
}

function unavailableWorktreeInfo(pathValue: string): AiVaultSessionWorktreeInfo {
  return {
    status: 'unavailable',
    label: aiVaultWorktreeCompactPath(pathValue),
    path: pathValue
  }
}
