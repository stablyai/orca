import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const taskPageSource = readFileSync(new URL('./TaskPage.tsx', import.meta.url), 'utf8')
const linearCreateDialogsSource = readFileSync(
  new URL('./task-page/hooks/use-task-page-linear-create-dialogs.ts', import.meta.url),
  'utf8'
)
const jiraCreateDialogSource = readFileSync(
  new URL('./task-page/hooks/use-task-page-jira-create-dialog.tsx', import.meta.url),
  'utf8'
)
const linearCreateSubmitSource = readFileSync(
  new URL('./task-page/hooks/use-task-page-create-linear-submits.tsx', import.meta.url),
  'utf8'
)
const jiraCreateSubmitSource = readFileSync(
  new URL('./task-page/hooks/use-task-page-create-jira-submit.ts', import.meta.url),
  'utf8'
)
const draftWriterSource = readFileSync(
  new URL('./task-page/dialogs/task-creation-draft-writers.ts', import.meta.url),
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
      new URL('./task-page/chrome/task-page-linear-filters.tsx', import.meta.url),
      'utf8'
    )
    const jiraFilters = readFileSync(
      new URL('./task-page/chrome/task-page-jira-filters.tsx', import.meta.url),
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
      linearCreateSubmitSource,
      'const handleCreateNewLinearProject',
      'const handleCreateNewLinearIssue'
    )
    expect(linearProjectSection).toContain('discardNewLinearProjectDraft()')

    const linearIssueSection = sectionBetween(
      linearCreateSubmitSource,
      'const handleCreateNewLinearIssue',
      'return {'
    )
    expect(linearIssueSection).toContain('discardNewLinearIssueDraft()')

    const jiraIssueSection = sectionBetween(
      jiraCreateSubmitSource,
      'const handleCreateNewJiraIssue',
      'return { handleCreateNewJiraIssue }'
    )
    expect(jiraIssueSection).toContain('discardNewJiraIssueDraft()')
  })

  it('surfaces Jira create transport failures without leaking stale-context toasts', () => {
    const jiraIssueSection = sectionBetween(
      jiraCreateSubmitSource,
      'const handleCreateNewJiraIssue',
      'return { handleCreateNewJiraIssue }'
    )
    expect(jiraIssueSection).toContain('} catch (error) {')
    expect(jiraIssueSection).toContain(
      'submitProviderRuntimeContextKey === providerRuntimeContextKeyRef.current'
    )
    expect(jiraIssueSection).toContain('toast.error(')
  })
})
