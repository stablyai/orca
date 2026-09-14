import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const COMPONENT_ROOT = __dirname

function componentSource(relativePath: string): string {
  return readFileSync(join(COMPONENT_ROOT, relativePath), 'utf8').replace(/\r\n?/g, '\n')
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
    const source = [
      componentSource('github-item-dialog/edit-item-fields/gh-edit-section.tsx'),
      componentSource('github-item-dialog/edit-item-fields/gh-edit-section-mutations.ts')
    ].join('\n')
    const issueUpdate = sourceBetween(
      componentSource('github/github-work-item-edit-mutations.ts'),
      'async function runIssueUpdate',
      'async function runWorkItemBodyUpdate'
    )
    const commentUpdate = sourceBetween(
      componentSource('github/github-work-item-comment-mutations.ts'),
      'function addIssueCommentForRepo',
      'function addPRReviewCommentForRepo'
    )
    const editSection = source

    expect(issueUpdate).toContain('sourceContext: args.sourceContext')
    expect(commentUpdate).toContain('sourceContext: args.sourceContext')
    expect(editSection).toContain('sourceContext,')
    expect(editSection).toContain(
      'patchWorkItem(itemId, { state: newState }, itemRepoId, { sourceContext })'
    )
    expect(editSection).toContain(
      'patchWorkItem(itemId, { labels: newLabels }, itemRepoId, { sourceContext })'
    )
  })

  it('threads GitLab task source context through the shared drawer selector', () => {
    const controllerSource = componentSource('GitLabItemDialog.tsx')
    const source = [
      controllerSource,
      componentSource('gitlab-item-dialog/use-gitlab-item-dialog-effects.ts'),
      componentSource('gitlab-item-dialog/use-gitlab-details-editing.ts'),
      componentSource('gitlab-item-dialog/use-gitlab-primary-actions.ts'),
      componentSource('gitlab-item-dialog/use-gitlab-review-actions.ts')
    ].join('\n')
    const selector = sourceBetween(
      controllerSource,
      'const repoSelector = useMemo',
      'const updateCommentDraft'
    )

    expect(selector).toContain('...(repoId ? { repoId } : {})')
    expect(selector).toContain('...(sourceContext ? { sourceContext } : {})')
    expect(selector).toContain('}, [repoId, repoPath, sourceContext])')
    expect(source).toContain('workItemDetails({ ...repoSelector')
    expect(source).toContain('updateMR({ ...repoSelector')
    expect(source).toContain('addMRComment({')
    expect(source).toContain('addIssueComment({')
    expect(source).toContain('...repoSelector')
  })

  it('uses Linear task source context for drawer reads, mutations, and optimistic patches', () => {
    const drawerSource = componentSource('LinearItemDrawer.tsx')
    const editSection = componentSource('linear-item-drawer-edit-controller.tsx')
    const drawer = sourceBetween(
      drawerSource,
      'export default function LinearItemDrawer',
      'return renderLinearItemDrawerSheet'
    )

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
