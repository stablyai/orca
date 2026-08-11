import type { GitHubAssignableUser } from '../../../shared/types'
import type { NewIssueDraft } from '@/store/slices/new-issue-draft'

export type NewIssueOpenSeed = {
  title: string
  body: string
  labels: string[]
  assignees: GitHubAssignableUser[]
  repoId: string | null
}

/** A draft is worth restoring only once it carries real user content — a typed
 *  title/body or a picked label/assignee. A bare `repoId` (or an all-empty
 *  form) is NOT content, so an "opened but never edited" modal never pins a
 *  meaningless draft and never hijacks a fresh open. Shared by the write-through
 *  gate and the restore-on-open decision so both agree on "has content". */
export function isNewIssueDraftContentful(
  draft: Pick<NewIssueDraft, 'title' | 'body' | 'labels' | 'assignees'> | null
): boolean {
  if (!draft) {
    return false
  }
  return (
    draft.title.trim().length > 0 ||
    draft.body.trim().length > 0 ||
    draft.labels.length > 0 ||
    draft.assignees.length > 0
  )
}

/** Pure "seed vs. restore on open" decision for the New GitHub issue modal.
 *  - No content-non-empty draft → empty defaults targeting the first selected
 *    repo (keeps a stale draft from hijacking a fresh open after the user
 *    changed their primary/selected repo).
 *  - Content draft whose repo is still selected → restore every field.
 *  - Content draft whose repo vanished from the selection → restore title/body
 *    only, drop the repo-scoped labels/assignees (they can't cross repos), and
 *    fall back to the first selected repo.
 *  Always resolves `repoId` to an explicit, in-selection id (never `null` while
 *  a target exists) so the vanish-guard can never misfire during a restore. */
export function resolveNewIssueOpenSeed(params: {
  draft: NewIssueDraft | null
  selectedRepoIds: readonly string[]
}): NewIssueOpenSeed {
  const { draft, selectedRepoIds } = params
  const fallbackRepoId = selectedRepoIds[0] ?? null
  if (!draft || !isNewIssueDraftContentful(draft)) {
    return { title: '', body: '', labels: [], assignees: [], repoId: fallbackRepoId }
  }
  if (draft.repoId !== null && selectedRepoIds.includes(draft.repoId)) {
    return {
      title: draft.title,
      body: draft.body,
      labels: draft.labels,
      assignees: draft.assignees,
      repoId: draft.repoId
    }
  }
  return {
    title: draft.title,
    body: draft.body,
    labels: [],
    assignees: [],
    repoId: fallbackRepoId
  }
}

/** The reset patch to apply when the user picks a different repo in the
 *  selector: repo-scoped labels/assignees can't cross a genuine repo switch, so
 *  both are dropped. Kept as a named helper so the imperative `Select` handler
 *  and its test share one contract instead of an untested inline literal. */
export function resolveUserRepoSwitchReset(): {
  labels: string[]
  assignees: GitHubAssignableUser[]
} {
  return { labels: [], assignees: [] }
}

/** Pure vanish-guard decision: when the chosen `newIssueRepoId` has left the
 *  selection (repo removed/deselected while a draft is open), returns the
 *  first-selected-repo fallback to reset the target to (the caller also drops
 *  the repo-scoped labels/assignees). Returns `null` when the chosen repo is
 *  still valid (or unset) — no reset needed. Because a restore always seeds an
 *  in-selection `repoId`, this returns `null` during a valid restore. */
export function resolveVanishedNewIssueRepoReset(
  newIssueRepoId: string | null,
  selectedRepoIds: readonly string[]
): { repoId: string | null } | null {
  if (newIssueRepoId === null || selectedRepoIds.includes(newIssueRepoId)) {
    return null
  }
  return { repoId: selectedRepoIds[0] ?? null }
}
