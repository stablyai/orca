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
  isGitBackedWorktree: boolean
}): boolean {
  if (!args.enabled || !args.isGitBackedWorktree || args.mode !== 'edit') {
    return false
  }
  // Why tracking is not a gate: a file HEAD has never seen (untracked, staged-add, renamed,
  // copied) diffs against an empty baseline and reads as entirely added. That green block is
  // the point — "none of this is committed yet" — so it is shown rather than suppressed.
  // Why no status check: the git-backed gate above already proves this is a repo, so an
  // unloaded status only means "not polled yet".
  //
  // Why conflicts still are a gate: conflict decorations own this same gutter lane
  // (monaco-conflict-decorations.ts) and stacking both is unreadable. Git's own conflict status
  // is the signal — scanning the buffer for marker text costs a full pass per keystroke and
  // reads a markdown `=======` setext underline as a conflict, killing the gutter for the file.
  return !entriesForPath(args.statusEntries ?? [], args.relativePath).some(
    (candidate) => candidate.conflictStatus === 'unresolved'
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
