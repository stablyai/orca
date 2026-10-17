/**
 * Cross-process types and pure helpers for the worktree merge-review flow:
 * a task worktree's branch is merged into the main checkout *uncommitted*, the
 * user reviews it there, then accepts (commit) or rejects (undo).
 *
 * State is derived from Git, never stored: a main checkout holding `MERGE_HEAD`
 * is pending review, and a stash whose subject carries the marker below is the
 * main checkout's own changes parked for the duration of the review.
 */

/**
 * Stash subject marker. Shared with the standalone `wf` tool on purpose, so a
 * stash parked from a terminal and one parked from Orca are the same stash.
 */
export const WORKTREE_MERGE_REVIEW_STASH_MARKER = 'wf-auto-stash'

/** Commit message for the temporary snapshot commit of a worktree's uncommitted
 *  changes. Must NOT contain the stash marker — this commit stays in history. */
export function worktreeMergeReviewSnapshotMessage(branch: string): string {
  return `wf: ${branch} uncommitted changes snapshot`
}

export type WorktreeMergeReviewState =
  | { phase: 'idle' }
  | { phase: 'pending'; branch: string | null; conflicts: string[] }

export type WorktreeMergeReviewSyncOutcome =
  | { kind: 'nothing-to-merge'; branch: string; targetBranch: string }
  | {
      kind: 'merged'
      branch: string
      targetBranch: string
      /** `git diff --cached --stat HEAD` output, for the success toast. */
      stat: string
      conflicts: string[]
      includedUncommittedChanges: boolean
      stashedMainChanges: boolean
    }

export type WorktreeMergeReviewAcceptOutcome =
  | { kind: 'committed'; summary: string }
  | { kind: 'stash-restored' }

export type WorktreeMergeReviewRejectOutcome =
  | { kind: 'rejected' }
  | { kind: 'stash-restored' }
  /** Hand edits made during review would be lost; the caller must confirm. */
  | { kind: 'needs-confirmation'; paths: string[] }

export const WORKTREE_MERGE_REVIEW_UNSUPPORTED_MESSAGE =
  'Merge review is not available for this workspace: it needs a local checkout. Run it on the host that owns the repository.'

export const WORKTREE_MERGE_REVIEW_MAIN_WORKTREE_UNSUPPORTED_MESSAGE =
  'Merge review needs the repository to have a main checkout.'

export function isWorktreeMergeReviewStashSubject(subject: string): boolean {
  return subject.includes(WORKTREE_MERGE_REVIEW_STASH_MARKER)
}

/**
 * Ref of the newest stash parked by the merge-review flow, or null.
 * Input is `git stash list --format=%gd%x00%gs` (NUL-separated ref and subject).
 */
export function findWorktreeMergeReviewStashRef(stashListOutput: string): string | null {
  for (const line of stashListOutput.split('\n')) {
    if (!line) {
      continue
    }
    const [ref, subject] = line.split('\0')
    if (ref && subject && isWorktreeMergeReviewStashSubject(subject)) {
      return ref
    }
  }
  return null
}

/**
 * Paths with worktree-side (unstaged) modifications — exactly what a
 * `reset --hard` would discard beyond the merge itself.
 *
 * Why the Y column of `--porcelain` and not `git diff --name-only`: during a
 * conflicted merge the latter omits unstaged edits to files the merged side
 * does not contain, so those hand edits would be dropped without ever being
 * shown in the confirmation.
 *
 * Input is `git status --porcelain -z --untracked-files=no` (NUL-terminated).
 */
export function parseUnstagedWorktreePaths(porcelainOutput: string): string[] {
  const fields = porcelainOutput.split('\0')
  const paths: string[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (field.length < 4) {
      continue
    }
    const indexStatus = field[0]
    const worktreeStatus = field[1]
    if (worktreeStatus !== ' ') {
      paths.push(field.slice(3))
    }
    // Why: a rename/copy record carries the source path in the next field, which has no status prefix.
    if (indexStatus === 'R' || indexStatus === 'C') {
      index += 1
    }
  }
  return paths
}

/** Branch a pending merge came from, from the first line of `MERGE_MSG`. */
export function parseWorktreeMergeReviewBranch(mergeMessage: string): string | null {
  const firstLine = mergeMessage.split('\n', 1)[0] ?? ''
  const match = /^Merge (?:remote-tracking )?branch '(.+)'$/.exec(firstLine)
  return match ? match[1] : null
}

/** Paths carrying conflict markers in the staged (merged) content. */
export function findConflictMarkerPaths(diffOutput: string): string[] {
  const hits = new Set<string>()
  let currentPath = ''
  for (const line of diffOutput.split('\n')) {
    if (line.startsWith('+++ ')) {
      currentPath = line.replace(/^\+\+\+ (?:b\/)?/, '')
      continue
    }
    if (/^\+(<{7}|>{7})(?: |$)/.test(line)) {
      hits.add(currentPath)
    }
  }
  return [...hits]
}
