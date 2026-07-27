import { normalizeAbsolutePathForComparison } from '@/components/right-sidebar/file-explorer-paths'

// Tracks Orca-owned moves in flight, for the rename + rekey duration only — no TTL, which would race a slow SSH rename.
// Source side only: while live, a watcher delete under any source ROOT is the move's own echo (prefix-matched so a file
// opened under a moving directory is covered), not an external delete — don't tombstone. Destination is verified by the coordinator.

type MoveOperation = {
  worktreeId: string
  runtimeEnvironmentId: string | null
  sourceRoots: string[]
}

const operations = new Map<string, MoveOperation>()

function owner(runtimeEnvironmentId: string | null | undefined): string | null {
  return runtimeEnvironmentId?.trim() || null
}

function normalize(absolutePath: string): string {
  return normalizeAbsolutePathForComparison(absolutePath)
}

// Both sides are normalized (separators folded, trailing slash trimmed), so a single-separator prefix check is exact.
function isInsideOrEqual(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`)
}

export function beginEditorPathMove(args: {
  operationId: string
  worktreeId: string
  runtimeEnvironmentId: string | null | undefined
  /** Move roots (fromPath); a delete under any of them is suppressed. */
  sourcePaths: readonly string[]
}): void {
  operations.set(args.operationId, {
    worktreeId: args.worktreeId,
    runtimeEnvironmentId: owner(args.runtimeEnvironmentId),
    sourceRoots: args.sourcePaths.map(normalize)
  })
}

export function settleEditorPathMove(operationId: string): void {
  operations.delete(operationId)
}

/** Cheap gate so watcher hot paths can skip per-file work when no move is live. */
export function hasActiveEditorPathMoves(): boolean {
  return operations.size > 0
}

/** True when this delete is the source side of a live Orca-owned move. */
export function isActiveMoveSourcePath(
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined,
  absolutePath: string
): boolean {
  // Runs per deleted open-editor in the fs-watcher hot path; skip the normalize regex when no move is live.
  if (operations.size === 0) {
    return false
  }
  const normalizedPath = normalize(absolutePath)
  const scopedOwner = owner(runtimeEnvironmentId)
  for (const operation of operations.values()) {
    if (operation.worktreeId !== worktreeId || operation.runtimeEnvironmentId !== scopedOwner) {
      continue
    }
    if (operation.sourceRoots.some((root) => isInsideOrEqual(root, normalizedPath))) {
      return true
    }
  }
  return false
}

export function __clearEditorPathMovesForTests(): void {
  operations.clear()
}

export function __activeEditorPathMoveCountForTests(): number {
  return operations.size
}
