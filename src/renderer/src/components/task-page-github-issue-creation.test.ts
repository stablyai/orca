import { describe, expect, it } from 'vitest'
import { readTaskPageSource } from './task-page-source-family.test-support'
import { readFileSync } from 'node:fs'

const taskPageSource = readTaskPageSource('use-task-page-github-issue-creation.ts')
const newIssueStateSource = readFileSync(
  new URL('./task-page/hooks/use-task-page-github-new-issue-state.ts', import.meta.url),
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
    expect(newIssueStateSource).toContain('(selectedRepos[0]?.id ?? null)')
    expect(newIssueStateSource).toContain('newIssueRepoId !== null')
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
