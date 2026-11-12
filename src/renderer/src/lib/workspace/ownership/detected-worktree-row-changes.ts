import { readRecordChanges } from '@/store/keyed-record-change-reads'

export type DetectedRowCatalog<W> = Record<string, { worktrees: readonly W[] }>

/** Unknown writes resync; accepted keyed writes inspect only the positions the writer replaced. */
export function detectedWorktreeChangesAreIrrelevant<L extends { worktrees: readonly unknown[] }>(
  previous: Record<string, L> | undefined,
  next: Record<string, L> | undefined,
  sameRow: (
    previous: L['worktrees'][number] | undefined,
    next: L['worktrees'][number] | undefined
  ) => boolean,
  sameListing: (previous: L, next: L) => boolean = () => true
): boolean {
  if (previous === next) {
    return true
  }
  if (!previous || !next) {
    return false
  }
  const changes = readRecordChanges(next, previous)
  if (changes?.kind !== 'addressed') {
    return false
  }
  for (const bucket of changes.keys) {
    const before = previous[bucket]
    const after = next[bucket]
    if (!before || !after || !sameListing(before, after)) {
      return false
    }
    if (before.worktrees === after.worktrees) {
      continue
    }
    const rows = readRecordChanges(after.worktrees, before.worktrees)
    if (rows?.kind !== 'addressed') {
      return false
    }
    for (const position of rows.keys) {
      if (!sameRow(before.worktrees[Number(position)], after.worktrees[Number(position)])) {
        return false
      }
    }
  }
  return true
}
