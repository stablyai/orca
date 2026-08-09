import type { GitStatusEntry } from '../../../../../shared/types'
import type { OpenFile } from '@/store/slices/editor'

function entriesForPath(
  statusEntries: readonly GitStatusEntry[],
  relativePath: string
): GitStatusEntry[] {
  return statusEntries.filter((candidate) => candidate.path === relativePath)
}

// Why: these all mean HEAD has no blob at this path, so a diff would report the whole file
// as new. `renamed` deliberately stays skipped rather than resolved through `oldPath` — VS
// Code diffs a rename against its source blob, but threading `oldPath` through is out of
// scope here.
const STATUSES_ABSENT_FROM_HEAD_AT_PATH: readonly GitStatusEntry['status'][] = [
  'untracked',
  'added',
  'copied',
  'renamed'
]

export function isGitGutterEligible(args: {
  enabled: boolean
  mode: OpenFile['mode']
  relativePath: string
  statusEntries: readonly GitStatusEntry[] | undefined
  hasConflictMarkers: boolean
  isGitBackedWorktree: boolean
}): boolean {
  // Why: conflict decorations already occupy this gutter lane (monaco-conflict-decorations.ts);
  // stacking both is unreadable.
  if (
    !args.enabled ||
    !args.isGitBackedWorktree ||
    args.mode !== 'edit' ||
    args.hasConflictMarkers
  ) {
    return false
  }
  // Why: without status we cannot tell "clean and tracked" from "untracked", and guessing
  // paints a brand-new file entirely green.
  if (!args.statusEntries) {
    return false
  }
  return !entriesForPath(args.statusEntries, args.relativePath).some((candidate) =>
    STATUSES_ABSENT_FROM_HEAD_AT_PATH.includes(candidate.status)
  )
}

/**
 * Identity of the baseline blob. When this changes the HEAD content may have changed, so the
 * baseline must be refetched. Typing never changes it.
 *
 * Why JSON.stringify(array) instead of a delimiter-joined string: worktreeId and relativePath
 * can themselves contain spaces (folder-workspace paths, filenames), so a plain separator lets
 * two different tuples collide, e.g. ['wt', 'a b'] and ['wt a', 'b'] both join to "wt a b".
 * JSON array encoding escapes quotes/backslashes inside each field, so field boundaries can
 * never be forged by field content.
 */
export function computeGitGutterBaselineToken(args: {
  worktreeId: string | null | undefined
  relativePath: string
  headSha: string | undefined
  statusEntries: readonly GitStatusEntry[] | undefined
}): string {
  const statusPart = (
    args.statusEntries ? entriesForPath(args.statusEntries, args.relativePath) : []
  )
    .map((candidate) => `${candidate.area}:${candidate.status}`)
    .sort()
  return JSON.stringify([args.worktreeId ?? '', args.relativePath, args.headSha ?? '', statusPart])
}
