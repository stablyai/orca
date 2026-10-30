import type { GitHubAssignableUser } from '../../../../shared/github/pull-request-types'
import type { NewIssueDraft } from '@/store/slices/new-issue-draft'

export type NewIssueOpenSeed = {
  title: string
  body: string
  labels: string[]
  assignees: GitHubAssignableUser[]
  repoId: string | null
}

/** Share the persistence/restore content gate so opening an untouched form cannot pin a repo-only draft. */
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

/** Restore contentful drafts in their selected repo; if it vanished, keep title/body but reset repo-scoped fields to the first selected repo. */
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

/** Clear labels/assignees on explicit repo changes because those fields cannot cross repos. */
export function resolveUserRepoSwitchReset(): {
  labels: string[]
  assignees: GitHubAssignableUser[]
} {
  return { labels: [], assignees: [] }
}

/** Reset a removed repo to the first selected repo; valid restored or unset targets need no reset. */
export function resolveVanishedNewIssueRepoReset(
  newIssueRepoId: string | null,
  selectedRepoIds: readonly string[]
): { repoId: string | null } | null {
  if (newIssueRepoId === null || selectedRepoIds.includes(newIssueRepoId)) {
    return null
  }
  return { repoId: selectedRepoIds[0] ?? null }
}
