import type { JiraIssue } from '../../../shared/jira/jira-types'
import type { LinkedJiraIssueRef } from '@/lib/jira-issue-workspace-attachment'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { readLinkedTaskIssuesWithLimit } from './read-linked-task-issues'
import { createTaskPageJiraLoadFailureState } from './task-page-jira-load-state'

export async function readLinkedJiraIssues(
  refs: readonly LinkedJiraIssueRef[],
  search: (
    jql: string,
    limit: number,
    options: { sourceContext?: TaskSourceContext | null; siteId: string; force: boolean }
  ) => Promise<JiraIssue[]>,
  sourceContext: TaskSourceContext | null | undefined,
  force: boolean
) {
  const results = await readLinkedTaskIssuesWithLimit(refs, async (ref) => {
    try {
      const issues = await search(`key = ${ref.key}`, 1, {
        sourceContext: ref.sourceContext ?? sourceContext,
        siteId: ref.siteId,
        force
      })
      return {
        issue:
          issues.find(
            (issue) =>
              issue.key.toUpperCase() === ref.key && (!issue.siteId || issue.siteId === ref.siteId)
          ) ?? null,
        error: null
      }
    } catch (error) {
      return { issue: null, error: createTaskPageJiraLoadFailureState(error).error }
    }
  })
  return {
    issues: results.flatMap((result) => (result?.issue ? [result.issue] : [])),
    error:
      results.find((result) => result?.error)?.error ??
      (results.some((result) => !result?.issue)
        ? createTaskPageJiraLoadFailureState(
            new Error(
              'Some Jira issues linked to workspaces could not be loaded. Refresh to try again.'
            )
          ).error
        : null),
    jqlRejection: null
  }
}

export function filterLinkedJiraIssues(issues: readonly JiraIssue[], query: string): JiraIssue[] {
  const needle = query.trim().toLowerCase()
  return issues.filter(
    (issue) =>
      !needle ||
      [issue.key, issue.title, issue.project.name, issue.assignee?.displayName ?? ''].some(
        (value) => value.toLowerCase().includes(needle)
      )
  )
}
