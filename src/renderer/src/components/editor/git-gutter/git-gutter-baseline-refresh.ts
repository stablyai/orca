import type { GitStatusEntry } from '../../../../../shared/types'
import type { OpenFile } from '@/store/slices/editor'

function entriesForPath(
  statusEntries: readonly GitStatusEntry[],
  relativePath: string
): GitStatusEntry[] {
  return statusEntries.filter((candidate) => candidate.path === relativePath)
}

export function isGitGutterEligible(args: {
  enabled: boolean
  mode: OpenFile['mode']
  relativePath: string
  statusEntries: readonly GitStatusEntry[] | undefined
  hasConflictMarkers: boolean
}): boolean {
  if (!args.enabled || args.mode !== 'edit' || args.hasConflictMarkers) {
    return false
  }
  // Why: without status we cannot tell "clean and tracked" from "untracked", and guessing
  // paints a brand-new file entirely green.
  if (!args.statusEntries) {
    return false
  }
  return !entriesForPath(args.statusEntries, args.relativePath).some(
    (candidate) => candidate.status === 'untracked'
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
