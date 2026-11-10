import type { ReviewedDiff } from './diff-reviewed-files'

export type DiffReviewNavigationEntry = {
  key: string
  entrySignature: string
  open: (placement: { placementWorkspaceId: string; targetGroupId?: string }) => void
}
const lists = new Map<string, readonly DiffReviewNavigationEntry[]>()

export function diffReviewListKey(ownerKey: string, scope: string): string {
  return JSON.stringify([
    ownerKey,
    scope === 'staged' || scope === 'unstaged' ? 'uncommitted' : scope
  ])
}

export function registerDiffReviewList(
  ownerKey: string,
  entries: readonly DiffReviewNavigationEntry[]
): () => void {
  lists.set(ownerKey, entries)
  return () => {
    if (lists.get(ownerKey) === entries) {
      lists.delete(ownerKey)
    }
  }
}

export function getDiffReviewList(ownerKey: string): readonly DiffReviewNavigationEntry[] {
  return lists.get(ownerKey) ?? []
}

export function nextDiffReviewEntry(
  entries: readonly DiffReviewNavigationEntry[],
  currentKey: string,
  records: ReadonlyMap<string, ReviewedDiff>
): DiffReviewNavigationEntry | undefined {
  const index = entries.findIndex((entry) => entry.key === currentKey)
  if (index === -1 || entries.length < 2) {
    return undefined
  }
  const isUnviewed = (entry: DiffReviewNavigationEntry) =>
    records.get(entry.key)?.entrySignature !== entry.entrySignature
  for (let i = index + 1; i < entries.length; i += 1) {
    if (isUnviewed(entries[i])) {
      return entries[i]
    }
  }
  for (let i = index - 1; i >= 0; i -= 1) {
    if (isUnviewed(entries[i])) {
      return entries[i]
    }
  }
  return entries[(index + 1) % entries.length]
}
