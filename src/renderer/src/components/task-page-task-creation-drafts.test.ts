import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  readTaskPageSource,
  readTaskPageSourceFamily
} from './task-page-source-family.test-support'

const taskPageSource = readTaskPageSourceFamily()
const linearCreateDialogsSource = readFileSync(
  new URL('./use-task-page-linear-creation-state.ts', import.meta.url),
  'utf8'
)
const jiraCreateDialogSource = readFileSync(
  new URL('./use-task-page-jira-creation-state.ts', import.meta.url),
  'utf8'
)
const jiraCreateSubmitSource = readFileSync(
  new URL('./use-task-page-jira-issue-creation.ts', import.meta.url),
  'utf8'
)
const draftWriterSource = readFileSync(
  new URL('./task-page-draft-storage.tsx', import.meta.url),
  'utf8'
)
const draftRetentionSource = [linearCreateDialogsSource, jiraCreateDialogSource].join('\n')

function sectionBetween(source: string, startAnchor: string, endAnchor: string): string {
  const start = source.indexOf(startAnchor)
  expect(start, `missing anchor: ${startAnchor}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endAnchor, start)
  expect(end, `missing anchor: ${endAnchor}`).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('TaskPage Linear/Jira creation drafts', () => {
  it('uses the contentful gate for each session draft writer', () => {
    expect(draftWriterSource.split('isTaskCreationDraftContentful(draft)')).toHaveLength(4)
  })

  it('retains all three drafts on dismissal without subscribing TaskPage to draft actions', () => {
    expect(draftRetentionSource.split('useTaskCreationDraftRetention({')).toHaveLength(4)
    expect(taskPageSource).not.toMatch(
      /useAppStore\(\(s\) => s\.(?:set|clear)New(?:LinearProject|LinearIssue|JiraIssue)Draft\)/
    )
    expect(draftRetentionSource).not.toMatch(
      /useAppStore\(\(s\) => s\.(?:set|clear)New(?:LinearProject|LinearIssue|JiraIssue)Draft\)/
    )
  })

  it('restores dismissed typed text when each dialog reopens', () => {
    const linearFilters = readFileSync(
      new URL('./task-page/linear/Filters.tsx', import.meta.url),
      'utf8'
    )
    const jiraFilters = readFileSync(
      new URL('./task-page/jira/Filters.tsx', import.meta.url),
      'utf8'
    )
    expect(linearFilters).toContain("setNewLinearProjectName(draft?.name ?? '')")
    expect(linearFilters).toContain("setNewLinearProjectDescription(draft?.description ?? '')")
    expect(linearFilters).toContain("setNewLinearProjectContent(draft?.content ?? '')")
    expect(linearFilters).toContain("setNewLinearIssueTitle(issueDraft?.title ?? '')")
    expect(linearFilters).toContain("setNewLinearIssueBody(issueDraft?.body ?? '')")
    expect(jiraFilters).toContain("setNewJiraIssueTitle(draft?.title ?? '')")
    expect(jiraFilters).toContain("setNewJiraIssueBody(draft?.body ?? '')")
  })

  it('discards each recovery draft only on a successful create', () => {
    const linearProjectSection = sectionBetween(
      readTaskPageSource('use-task-page-linear-project-creation.ts'),
      'const handleCreateNewLinearProject',
      'const nextModel'
    )
    expect(linearProjectSection).toContain('discardNewLinearProjectDraft()')

    const linearIssueSection = sectionBetween(
      readTaskPageSource('use-task-page-linear-issue-creation.ts'),
      'const handleCreateNewLinearIssue',
      'const nextModel'
    )
    expect(linearIssueSection).toContain('discardNewLinearIssueDraft()')

    const jiraIssueSection = sectionBetween(
      readTaskPageSource('use-task-page-jira-issue-creation.ts'),
      'const handleCreateNewJiraIssue',
      'const nextModel'
    )
    expect(jiraIssueSection).toContain('discardNewJiraIssueDraft()')
  })

  it('surfaces Jira create transport failures without leaking stale-context toasts', () => {
    const jiraIssueSection = sectionBetween(
      jiraCreateSubmitSource,
      'const handleCreateNewJiraIssue',
      'const nextModel'
    )
    expect(jiraIssueSection).toContain('} catch (error) {')
    expect(jiraIssueSection).toContain(
      'submitProviderRuntimeContextKey === providerRuntimeContextKeyRef.current'
    )
    expect(jiraIssueSection).toContain('toast.error(')
  })
})
