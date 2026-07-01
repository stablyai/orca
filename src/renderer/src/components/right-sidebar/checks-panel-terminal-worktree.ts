import { parseWslUncPath } from '../../../../shared/wsl-paths'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree-id'
import {
  isPathInsideOrEqual,
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison
} from '../../../../shared/cross-platform-path'
import type { TerminalLayoutSnapshot, Worktree } from '../../../../shared/types'

type TerminalPtyContext = {
  activeTabId: string | null
  ptyIdsByTabId: Record<string, readonly string[] | undefined>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot | undefined>
}

type WorktreeCandidate = {
  worktree: Worktree
  path: string
  source: 'current-path' | 'prior-path'
}

/** Resolve the active terminal PTY that should provide Checks panel cwd context. */
export function resolveChecksPanelTerminalPtyId(context: TerminalPtyContext): string | null {
  if (!context.activeTabId) {
    return null
  }

  const livePtyIds = context.ptyIdsByTabId[context.activeTabId] ?? []
  if (livePtyIds.length === 0) {
    return null
  }

  const layout = context.terminalLayoutsByTabId[context.activeTabId]
  const activeLeafPtyId = layout?.activeLeafId ? layout.ptyIdsByLeafId?.[layout.activeLeafId] : null
  if (activeLeafPtyId && livePtyIds.includes(activeLeafPtyId)) {
    return activeLeafPtyId
  }

  const firstLiveLayoutPtyId = Object.values(layout?.ptyIdsByLeafId ?? {}).find((ptyId) =>
    livePtyIds.includes(ptyId)
  )
  // Last tab PTY is the newest terminal when the split-pane layout is stale or unavailable.
  return firstLiveLayoutPtyId ?? livePtyIds.at(-1) ?? null
}

/** Resolve the worktree whose current or prior path contains the terminal cwd. */
export function resolveChecksPanelWorktreeFromTerminalCwd(
  cwd: string | null,
  worktrees: readonly Worktree[]
): Worktree | null {
  const terminalCwd = cwd?.trim()
  if (!terminalCwd || !isRuntimePathAbsolute(terminalCwd)) {
    return null
  }

  const best = buildWorktreeCandidates(worktrees)
    .filter((candidate) => isTerminalCwdInsideWorktree(candidate.path, terminalCwd))
    .sort(compareWorktreeCandidates)[0]

  return best?.worktree ?? null
}

function buildWorktreeCandidates(worktrees: readonly Worktree[]): WorktreeCandidate[] {
  const candidates: WorktreeCandidate[] = []
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

  // Windows hosts store WSL worktrees as UNC paths, while the terminal reports Linux paths.
  const wslPath = parseWslUncPath(worktreePath)
  return wslPath ? isPathInsideOrEqual(wslPath.linuxPath, terminalCwd) : false
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
  // Prefer the current path when a renamed worktree still has a matching prior path.
  return left.source === 'current-path' ? -1 : 1
}
