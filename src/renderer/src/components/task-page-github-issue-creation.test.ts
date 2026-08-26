import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const taskPageSource = readFileSync(
  new URL('./task-page/hooks/use-task-page-create-github-submit.ts', import.meta.url),
  'utf8'
)
const newIssueStateSource = readFileSync(
  new URL('./task-page/hooks/use-task-page-github-new-issue-state.ts', import.meta.url),
  'utf8'
)

function issueCreationSection(): string {
  const start = taskPageSource.indexOf('const handleCreateNewIssue')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = taskPageSource.indexOf('return { handleCreateNewIssue }', start)
  expect(end).toBeGreaterThan(start)
  return taskPageSource.slice(start, end)
}

describe('TaskPage GitHub issue creation', () => {
  it('keeps issue creation targeted to the first selected repo on a fresh mount', () => {
    expect(newIssueStateSource).toContain('(selectedRepos[0]?.id ?? null)')
    expect(newIssueStateSource).toContain('newIssueRepoId !== null')
  })

  it('covers the complete remote oversized-body recovery timeout envelope', () => {
    const section = issueCreationSection()

    expect(section).toContain("'github.createIssue'")
    expect(section).toContain('{ timeoutMs: 65_000 }')
  })

  it('treats a body-save warning as created while preserving the recovery draft', () => {
    const section = issueCreationSection()
    const warningBranch = section.slice(
      section.indexOf('if (result.bodySaveWarning)'),
      section.indexOf('// Why: bump the nonce')
    )

    expect(warningBranch).toContain('toast.warning')
    expect(warningBranch).toContain('description: result.bodySaveWarning')
    expect(warningBranch).toContain("setNewIssueDraft({ title: '' })")
    expect(warningBranch).toContain('} else {')
    expect(warningBranch).toContain('clearNewIssueDraft()')
  })
})
