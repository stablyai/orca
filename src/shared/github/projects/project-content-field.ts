import type { GitHubProjectRow } from './project-types'

type ProjectContent = Pick<
  GitHubProjectRow['content'],
  'repository' | 'linkedPullRequests' | 'subIssuesProgress'
> & { parentIssue?: GitHubProjectRow['content']['parentIssue'] }

export type ProjectContentField =
  | { kind: 'parent'; parent: NonNullable<ProjectContent['parentIssue']> }
  | { kind: 'repository'; repository: string }
  | { kind: 'progress'; progress: NonNullable<ProjectContent['subIssuesProgress']> }
  | { kind: 'linked'; linked: NonNullable<ProjectContent['linkedPullRequests']> }

// Undefined leaves unsupported fields on the field-value path; null is authoritative emptiness.
export function projectContentField(
  content: ProjectContent,
  dataType: string
): ProjectContentField | null | undefined {
  switch (dataType) {
    case 'PARENT_ISSUE':
      return content.parentIssue ? { kind: 'parent', parent: content.parentIssue } : null
    case 'REPOSITORY':
      return content.repository ? { kind: 'repository', repository: content.repository } : null
    case 'SUB_ISSUES_PROGRESS':
      return content.subIssuesProgress && content.subIssuesProgress.total !== 0
        ? { kind: 'progress', progress: content.subIssuesProgress }
        : null
    case 'LINKED_PULL_REQUESTS':
      return content.linkedPullRequests &&
        (content.linkedPullRequests.pullRequests.length > 0 ||
          content.linkedPullRequests.totalCount > 0)
        ? { kind: 'linked', linked: content.linkedPullRequests }
        : null
    default:
      return undefined
  }
}

export function projectContentFieldLabel(value: ProjectContentField): string {
  switch (value.kind) {
    case 'parent':
      return `#${value.parent.number}`
    case 'repository':
      return value.repository
    case 'progress':
      return `${value.progress.completed}/${value.progress.total} (${value.progress.percentCompleted}%)`
    case 'linked':
      return value.linked.pullRequests.map((pr) => `#${pr.number}`).join(', ')
  }
}

export function projectContentFieldSortValue(
  value: ProjectContentField | null
): string | number | null {
  if (!value) {
    return null
  }
  switch (value.kind) {
    case 'parent':
      return value.parent.number
    case 'repository':
      return value.repository
    case 'progress':
      return value.progress.percentCompleted
    case 'linked':
      return value.linked.pullRequests[0]?.number ?? null
  }
}
