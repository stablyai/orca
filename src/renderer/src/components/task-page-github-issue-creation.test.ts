import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const taskPageSource = readFileSync(new URL('./TaskPage.tsx', import.meta.url), 'utf8')

function issueCreationSection(): string {
  const start = taskPageSource.indexOf('const handleCreateNewIssue')
  const end = taskPageSource.indexOf('const handleCreateNewLinearProject', start)
  return taskPageSource.slice(start, end)
}

describe('TaskPage GitHub issue creation', () => {
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
