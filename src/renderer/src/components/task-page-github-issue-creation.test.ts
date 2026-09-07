import { describe, expect, it } from 'vitest'
import { readTaskPageSource } from './task-page-source-family.test-support'
import { readFileSync } from 'node:fs'

const taskPageSource = readTaskPageSource('use-task-page-github-issue-creation.ts')
const newIssueDraftSource = readFileSync(
  new URL('./use-task-page-github-issue-draft.ts', import.meta.url),
  'utf8'
)
const newIssueRepoResetSource = readFileSync(
  new URL('./task-page-new-issue-draft.ts', import.meta.url),
  'utf8'
)

function issueCreationSection(): string {
  const start = taskPageSource.indexOf('const handleCreateNewIssue')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = taskPageSource.indexOf('const nextModel', start)
  expect(end).toBeGreaterThan(start)
  return taskPageSource.slice(start, end)
}

describe('TaskPage GitHub issue creation', () => {
  it('keeps issue creation targeted to the first selected repo on a fresh mount', () => {
    expect(newIssueDraftSource).toContain(
      'selectedRepos.find((r) => r.id === newIssueRepoId) ?? selectedRepos[0] ?? null'
    )
    // Why: a repo leaving the selection mid-draft must reset to the first selected repo.
    expect(newIssueRepoResetSource).toContain('newIssueRepoId === null')
    expect(newIssueRepoResetSource).toContain('return { repoId: selectedRepoIds[0] ?? null }')
  })

  it('covers the complete remote oversized-body recovery timeout envelope', () => {
    const section = issueCreationSection()

    expect(section).toContain("'github.createIssue'")
    expect(section).toMatch(/\{\s*timeoutMs: 65_000\s*\}/)
  })

  it('treats a body-save warning as created while preserving the recovery draft', () => {
    const section = issueCreationSection()
    const warningBranch = section.slice(
      section.indexOf('if (result.bodySaveWarning)'),
      section.indexOf('// Why: bump the nonce')
    )

    expect(warningBranch).toContain('toast.warning')
    expect(warningBranch).toContain('description: result.bodySaveWarning')
    expect(warningBranch).toMatch(/setNewIssueDraft\(\{\s*title: ''\s*\}\)/)
    expect(warningBranch).toContain('} else {')
    expect(warningBranch).toContain('clearNewIssueDraft()')
  })
})
