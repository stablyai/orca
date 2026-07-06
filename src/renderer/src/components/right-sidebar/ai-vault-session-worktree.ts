import { useMemo } from 'react'
import { parseWslUncPath } from '../../../../shared/wsl-paths'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree-id'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import {
  isPathInsideOrEqual,
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison
} from '../../../../shared/cross-platform-path'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { Repo, Worktree } from '../../../../shared/types'
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
  if (!session.cwd) {
    return null
  }

  const sessionHostId = normalizeExecutionHostId(session.executionHostId)
  const candidates = buildWorktreeCandidates(worktrees, repos)
    .filter((candidate) => isSessionInWorktreePath(candidate.path, session.cwd!))
    .filter((candidate) => !sessionHostId || candidate.hostId === sessionHostId)
    .sort(compareWorktreeCandidates)

  const best = candidates[0]
  if (!best) {
    return {
      status: 'unavailable',
      label: compactPathLabel(session.cwd),
      path: session.cwd
    }
  }

  const status =
    best.worktree.id === activeWorktreeId
      ? 'current'
      : best.worktree.isArchived
        ? 'archived'
        : best.status

  return {
    status,
    label: best.worktree.displayName || compactPathLabel(best.path),
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
  repos?: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
  worktrees: readonly Worktree[]
  activeWorktreeId: string | null
}): AiVaultSessionWorktreeInfo | null {
  const resolved = resolveAiVaultSessionWorktreeInfo(args)
  if (resolved) {
    return resolved
  }

  const cwd = args.session.cwd?.trim()
  if (cwd) {
    return unavailableWorktreeInfo(cwd)
  }

  const titlePath = extractWorktreePathFromSessionTitle(args.session.title)
  if (titlePath) {
    return unavailableWorktreeInfo(titlePath)
  }

  const branch = args.session.branch?.trim()
  if (branch) {
    return {
      status: 'unavailable',
      label: branch,
      path: branch
    }
  }

  return null
}

export function useAiVaultSessionWorktreeMap({
  sessions,
  repos = [],
  worktrees,
  activeWorktreeId
}: {
  sessions: readonly AiVaultSession[]
  repos?: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
  worktrees: readonly Worktree[]
  activeWorktreeId: string | null
}): ReadonlyMap<string, AiVaultSessionWorktreeInfo> {
  return useMemo(
    () =>
      new Map(
        sessions.flatMap((session) => {
          const worktreeInfo = resolveAiVaultSessionWorktreeDisplay({
            session,
            repos,
            worktrees,
            activeWorktreeId
          })
          return worktreeInfo ? [[session.id, worktreeInfo] as const] : []
        })
      ),
    [activeWorktreeId, repos, sessions, worktrees]
  )
}

function buildWorktreeCandidates(
  worktrees: readonly Worktree[],
  repos: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
): WorktreeCandidate[] {
  const candidates: WorktreeCandidate[] = []
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  for (const worktree of worktrees) {
    const repo = repoById.get(worktree.repoId)
    const hostId =
      normalizeExecutionHostId(worktree.hostId) ??
      (repo ? getRepoExecutionHostId(repo) : LOCAL_EXECUTION_HOST_ID)
    if (hasUsablePath(worktree.path)) {
      candidates.push({
        worktree,
        path: worktree.path,
        hostId,
        status: worktree.isArchived ? 'archived' : 'active',
        source: 'current-path'
      })
    }
    for (const priorWorktreeId of worktree.priorWorktreeIds ?? []) {
      const parsed = splitWorktreeIdForFilesystem(priorWorktreeId)
      if (!parsed || parsed.repoId !== worktree.repoId || !hasUsablePath(parsed.worktreePath)) {
        continue
      }
      candidates.push({
        worktree,
        path: parsed.worktreePath,
        hostId,
        status: worktree.isArchived ? 'archived' : 'active',
        source: 'prior-path'
      })
    }
  }
  return candidates
}

function hasUsablePath(pathValue: string): boolean {
  const trimmed = pathValue.trim()
  return Boolean(trimmed && isRuntimePathAbsolute(trimmed))
}

function isSessionInWorktreePath(worktreePath: string, sessionCwd: string): boolean {
  if (isPathInsideOrEqual(worktreePath, sessionCwd)) {
    return true
  }
  const wslPath = parseWslUncPath(worktreePath)
  return wslPath ? isPathInsideOrEqual(wslPath.linuxPath, sessionCwd) : false
}

function compareWorktreeCandidates(left: WorktreeCandidate, right: WorktreeCandidate): number {
  const lengthDifference =
    normalizeRuntimePathForComparison(right.path).length -
    normalizeRuntimePathForComparison(left.path).length
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
    label: compactPathLabel(pathValue),
    path: pathValue
  }
}

function compactPathLabel(pathValue: string): string {
  return aiVaultWorktreeCompactPath(pathValue)
}
