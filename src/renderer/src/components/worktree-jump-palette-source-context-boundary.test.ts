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
  it('resolves typed GitHub issue/PR entries through the lookup repo source host', () => {
    expect(source).toContain('buildTaskSourceContextFromRepo')

    const githubLinkSection = sourceBetween(
      'void lookupGitHubWorkItemByOwnerRepoForSource({',
      '// Case 2: user typed a raw issue number.'
    )
    expect(githubLinkSection).toContain('sourceContext')

    const rawNumberSection = sourceBetween(
      'void lookupGitHubWorkItemForSource({',
      '.then((item) => {'
    )
    expect(rawNumberSection).toContain('sourceContext')
  })
})
