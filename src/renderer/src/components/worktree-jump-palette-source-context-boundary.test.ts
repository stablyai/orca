import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, 'WorktreeJumpPalette.tsx'), 'utf8')

function sourceBetween(startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('WorktreeJumpPalette source-context boundaries', () => {
  it('attaches a resolved GitHub URL entity and leaves GitLab/Jira as raw URLs', () => {
    // Why: GitHub create reuses the Cmd+J preview (lookup lives in the effect,
    // not Case 1). GitLab/Jira still hand the raw URL to the composer.
    const githubLinkSection = sourceBetween(
      '// Case 1: user pasted a GH/GitLab/Jira URL.',
      '// Case 2: user typed a raw issue number.'
    )
    expect(githubLinkSection).toContain('linkedWorkItem')
    expect(githubLinkSection).toContain('initialGitHubWorkItem: item')
    expect(githubLinkSection).toContain('prefilledName: trimmed')
    expect(githubLinkSection).not.toContain('lookupGitHubWorkItemByOwnerRepoForSource')
  })

  it('resolves typed raw issue/PR numbers through the lookup repo source host', () => {
    expect(source).toContain('buildTaskSourceContextFromRepo')

    const rawNumberSection = sourceBetween(
      'void lookupGitHubWorkItemForSource({',
      '.then((item) => {'
    )
    expect(rawNumberSection).toContain('sourceContext')
  })
})
