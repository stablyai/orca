import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { branchName } from '@/lib/git-utils'
import { parseWslUncPath } from '../../../../shared/wsl-paths'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree-id'
import {
  getRuntimePathBasename,
  isPathInsideOrEqual,
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison
} from '../../../../shared/cross-platform-path'
import type { Worktree } from '../../../../shared/types'

export type LiveWorktreeMismatchCandidate = Pick<
  Worktree,
  'id' | 'repoId' | 'path' | 'branch' | 'displayName' | 'priorWorktreeIds' | 'hostId'
>

type WorktreePathCandidate = {
  worktree: LiveWorktreeMismatchCandidate
  path: string
  source: 'current-path' | 'prior-path'
}

/**
 * Resolve the known worktree whose path contains liveCwd (longest match wins).
 * Ordinary cds outside every known worktree return null — no noise.
 */
export function resolveLiveWorktreeFromCwd(
  liveCwd: string | null | undefined,
  worktrees: readonly LiveWorktreeMismatchCandidate[]
): LiveWorktreeMismatchCandidate | null {
  const terminalCwd = liveCwd?.trim()
  if (!terminalCwd || !isRuntimePathAbsolute(terminalCwd)) {
    return null
  }

  const best = buildWorktreePathCandidates(worktrees)
    .filter((candidate) => isTerminalCwdInsideWorktree(candidate.path, terminalCwd))
    .sort(compareWorktreePathCandidates)[0]

  return best?.worktree ?? null
}

/**
 * When live cwd maps to a different known sibling worktree of the same repo
 * (and host), return a compact label like `in worktree-foo`. Otherwise null.
 */
export function resolveLiveWorktreeMismatchLabel(args: {
  liveCwd: string | null | undefined
  attributedWorktreeId: string
  worktrees: readonly LiveWorktreeMismatchCandidate[]
}): string | null {
  const attributed = args.worktrees.find((worktree) => worktree.id === args.attributedWorktreeId)
  if (!attributed) {
    return null
  }

  const siblings = args.worktrees.filter(
    (worktree) =>
      worktree.repoId === attributed.repoId &&
      (worktree.hostId === undefined ||
        attributed.hostId === undefined ||
        worktree.hostId === attributed.hostId)
  )
  const live = resolveLiveWorktreeFromCwd(args.liveCwd, siblings)
  if (!live || live.id === attributed.id) {
    return null
  }
  return formatLiveWorktreeMismatchLabel(live)
}

export function formatLiveWorktreeMismatchLabel(
  worktree: Pick<LiveWorktreeMismatchCandidate, 'branch' | 'displayName' | 'path'>
): string {
  const branch = worktree.branch?.trim() ? branchName(worktree.branch).trim() : ''
  const displayName = worktree.displayName?.trim() ?? ''
  const base = branch || displayName || getRuntimePathBasename(worktree.path) || worktree.path
  return `in ${base}`
}

/** Attach mismatch labels from live OSC-7 cwd without re-attributing rows. */
export function applyLiveWorktreeMismatchLabels(
  rows: DashboardAgentRow[],
  args: {
    liveCwdByPaneKey: ReadonlyMap<string, string> | Record<string, string>
    worktrees: readonly LiveWorktreeMismatchCandidate[]
  }
): DashboardAgentRow[] {
  if (rows.length === 0 || args.worktrees.length === 0) {
    return rows
  }

  let changed = false
  const next = rows.map((row) => {
    const lookupKey = row.activationPaneKey ?? row.paneKey
    const liveCwd = readLiveCwd(args.liveCwdByPaneKey, lookupKey)
    const label = resolveLiveWorktreeMismatchLabel({
      liveCwd,
      attributedWorktreeId: row.tab.worktreeId,
      worktrees: args.worktrees
    })
    if (label === (row.liveWorktreeMismatchLabel ?? null)) {
      return row
    }
    changed = true
    if (!label) {
      if (row.liveWorktreeMismatchLabel === undefined) {
        return row
      }
      const { liveWorktreeMismatchLabel: _removed, ...rest } = row
      return rest
    }
    return { ...row, liveWorktreeMismatchLabel: label }
  })
  return changed ? next : rows
}

function readLiveCwd(
  map: ReadonlyMap<string, string> | Record<string, string>,
  paneKey: string
): string | undefined {
  if (map instanceof Map) {
    return map.get(paneKey)
  }
  return map[paneKey]
}

function buildWorktreePathCandidates(
  worktrees: readonly LiveWorktreeMismatchCandidate[]
): WorktreePathCandidate[] {
  const candidates: WorktreePathCandidate[] = []
  for (const worktree of worktrees) {
    if (hasUsablePath(worktree.path)) {
      candidates.push({ worktree, path: worktree.path, source: 'current-path' })
    }
    for (const priorWorktreeId of worktree.priorWorktreeIds ?? []) {
      const parsed = splitWorktreeIdForFilesystem(priorWorktreeId)
      if (!parsed || parsed.repoId !== worktree.repoId || !hasUsablePath(parsed.worktreePath)) {
        continue
      }
      candidates.push({ worktree, path: parsed.worktreePath, source: 'prior-path' })
    }
  }
  return candidates
}

function hasUsablePath(pathValue: string): boolean {
  const trimmed = pathValue.trim()
  return Boolean(trimmed && isRuntimePathAbsolute(trimmed))
}

function isTerminalCwdInsideWorktree(worktreePath: string, terminalCwd: string): boolean {
  if (isPathInsideOrEqual(worktreePath, terminalCwd)) {
    return true
  }
  const wslPath = parseWslUncPath(worktreePath)
  return wslPath ? isPathInsideOrEqual(wslPath.linuxPath, terminalCwd) : false
}

function compareWorktreePathCandidates(
  left: WorktreePathCandidate,
  right: WorktreePathCandidate
): number {
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
