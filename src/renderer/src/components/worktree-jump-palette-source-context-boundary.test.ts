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
  it('defers pasted GitHub URL resolution to the composer so cross-project detection runs', () => {
    // Why: pasting a cross-project URL must surface the same "Switch project?"
    // prompt as Cmd+N. The palette hands the raw URL to the composer's name
    // field instead of pre-resolving it against an arbitrary repo, which
    // silently linked cross-project items to the wrong project.
    const githubLinkSection = sourceBetween(
      '// Case 1: user pasted a GH issue/PR URL.',
      '// Case 2: user typed a raw issue number.'
    )
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
