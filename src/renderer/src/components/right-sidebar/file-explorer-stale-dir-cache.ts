import type { DirCache } from './file-explorer-types'

export type ExpandedDirLoadDecision = 'skip' | 'load' | 'reload'

/** Choose first/forced/no read; callers must first skip reads already tracked by the separate loading set. */
export function decideExpandedDirLoad(
  cached: DirCache | undefined,
  stale: boolean
): ExpandedDirLoadDecision {
  if (!cached || (!cached.children.length && !cached.operationOwner)) {
    return 'load'
  }
  return stale ? 'reload' : 'skip'
}
