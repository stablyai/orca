import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const COMPONENT_ROOT = __dirname

function componentSource(relativePath: string): string {
  return readFileSync(join(COMPONENT_ROOT, relativePath), 'utf8')
}

function sourceBetween(source: string, startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('task drawer source boundaries', () => {
  it('threads GitHub task source context through detail mutations', () => {
    const source = componentSource('GitHubItemDialog.tsx')
    const issueUpdate = sourceBetween(
      source,
      'async function runIssueUpdate',
      'async function runWorkItemBodyUpdate'
    )
    const commentUpdate = sourceBetween(
      source,
      'function addIssueCommentForRepo',
      'function addPRReviewCommentForRepo'
    )
    const editSection = sourceBetween(
      source,
      'function GHEditSection',
      'function GHCommentComposer'
    )

    expect(issueUpdate).toContain('sourceContext: args.sourceContext')
    expect(commentUpdate).toContain('sourceContext: args.sourceContext')
    expect(editSection).toContain('sourceContext,')
    expect(editSection).toContain(
      'patchWorkItem(item.id, { state: newState }, item.repoId, { sourceContext })'
    )
    expect(editSection).toContain(
      'patchWorkItem(item.id, { labels: newLabels }, item.repoId, { sourceContext })'
    )
  })

  it('threads GitLab task source context through the shared drawer selector', () => {
    const source = componentSource('GitLabItemDialog.tsx')
    const selector = sourceBetween(
      source,
      'const repoSelector = useMemo',
      'const updateCommentDraft'
    )

    expect(selector).toContain('...(repoId ? { repoId } : {})')
    expect(selector).toContain('...(sourceContext ? { sourceContext } : {})')
    expect(selector).toContain('}, [repoId, repoPath, sourceContext])')
    expect(source).toContain('workItemDetails({ ...repoSelector')
    expect(source).toContain('updateMR({ ...repoSelector')
    expect(source).toContain('addMRComment({ ...repoSelector')
    expect(source).toContain('addIssueComment({ ...repoSelector')
  })

  it('uses Linear task source context for drawer reads, mutations, and optimistic patches', () => {
    const source = componentSource('LinearItemDrawer.tsx')
    const editSection = sourceBetween(
      source,
      'export function LinearIssueEditSection',
      'export function LinearIssueCommentFooter'
    )
    const drawer = sourceBetween(source, 'export default function LinearItemDrawer', 'return (')

    expect(editSection).toContain('const providerSettings = sourceContext ?? settings')
    expect(editSection).toContain('linearUpdateIssue(providerSettings')
    expect(editSection).toContain(
      'patchLinearIssue(issue.id, { state: stateValue }, { sourceContext })'
    )
    expect(editSection).toContain(
      'patchLinearIssue(issue.id, { assignee: newAssignee }, { sourceContext })'
    )
    expect(drawer).toContain('const providerSettings = sourceContext ?? settings')
    expect(drawer).toContain('linearGetIssue(providerSettings')
    expect(drawer).toContain('linearIssueComments(providerSettings')
  })

  it('uses Jira task source context for drawer reads, mutations, and optimistic patches', () => {
    const source = componentSource('JiraIssueWorkspace.tsx')
    const drawer = sourceBetween(source, 'export default function JiraIssueWorkspace', 'return (')

    expect(drawer).toContain('const providerSettings = sourceContext ?? settings')
    expect(drawer).toContain('jiraIssueComments(providerSettings')
    expect(drawer).toContain('jiraGetIssue(providerSettings')
    expect(drawer).toContain('jiraListTransitions(providerSettings')
    expect(drawer).toContain('jiraUpdateIssue(providerSettings')
    expect(drawer).toContain('jiraAddIssueComment(')
    expect(drawer).toContain('patchJiraIssue(displayed.key, optimistic, { sourceContext })')
    expect(drawer).toContain('patchJiraIssue(previous.key, previous, { sourceContext })')
  })
})
