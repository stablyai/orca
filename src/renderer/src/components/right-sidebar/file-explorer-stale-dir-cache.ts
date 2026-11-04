import type { DirCache } from './file-explorer-types'

/** Overflow invalidates collapsed cached listings too; mark them stale so re-expansion rereads instead of showing old children. */
export function collectStaleDirCachePaths(
  cache: Record<string, DirCache>,
  worktreePath: string,
  expanded: Set<string>
): string[] {
  return Object.keys(cache).filter((dirPath) => dirPath !== worktreePath && !expanded.has(dirPath))
}

export type ExpandedDirLoadDecision = 'skip' | 'load' | 'reload'

/** Choose first/forced/no read; callers must first skip reads already tracked by the separate loading set. */
export function decideExpandedDirLoad(
  cached: DirCache | undefined,
  stale: boolean
): ExpandedDirLoadDecision {
  if (!cached?.children.length) {
    return 'load'
  }
  return stale ? 'reload' : 'skip'
}
