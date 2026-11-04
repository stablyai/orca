import { normalizeAbsolutePathForComparison } from '@/components/right-sidebar/file-explorer-paths'

// Track source-root delete echoes until rename and rekey settle, without a TTL that could race slow SSH moves. The coordinator verifies destinations.

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

// Normalize both paths first so one separator boundary safely distinguishes descendants from siblings.
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

export function hasActiveEditorPathMoves(): boolean {
  return operations.size > 0
}

export function isActiveMoveSourcePath(
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined,
  absolutePath: string
): boolean {
  // Skip path normalization on watcher hot paths when no move is active.
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
