import type { GitBranchChangeEntry, GitStatusEntry } from '../../../../shared/types'
import type { CombinedDiffFileTreeMode } from './combined-diff-file-tree-model'

export type CombinedDiffEntryIdentityInput = {
  mode: CombinedDiffFileTreeMode
  entry: GitStatusEntry | GitBranchChangeEntry
  mergeBase?: string | null
  headOid?: string | null
  commitOid?: string | null
  parentOid?: string | null
}

function fnv1aHash(parts: readonly string[]): string {
  let hash = 2166136261
  for (const part of parts) {
    hash = Math.imul(hash ^ part.length, 16777619)
    for (let index = 0; index < part.length; index += 1) {
      hash = Math.imul(hash ^ part.charCodeAt(index), 16777619)
    }
  }
  return `d${(hash >>> 0).toString(36)}`
}

export function buildCombinedDiffEntryIdentity({
  mode,
  entry,
  mergeBase,
  headOid,
  commitOid,
  parentOid
}: CombinedDiffEntryIdentityInput): string {
  const area =
    'area' in entry ? entry.area : mode === 'commit' ? 'combined-commit' : 'combined-branch'
  const parts = [
    area,
    entry.status,
    entry.oldPath ?? '',
    entry.path,
    String(entry.added ?? ''),
    String(entry.removed ?? '')
  ]

  if (mode === 'branch' || (mode === 'all' && !('area' in entry))) {
    parts.push(mergeBase ?? '', headOid ?? '')
  } else if (mode === 'commit') {
    parts.push(commitOid ?? '', parentOid ?? '')
  }

  return fnv1aHash(parts)
}
