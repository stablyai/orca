import { describe, expect, it } from 'vitest'
import { readWorktreeJumpPaletteSource } from './worktree-jump-palette-source.test-support'

const source = [
  readWorktreeJumpPaletteSource('use-worktree-jump-palette-create-action.ts'),
  readWorktreeJumpPaletteSource('worktree-jump-palette-create-worktree.ts')
].join('\n')

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
    const githubLinkSection = sourceBetween('if (ghLink) {', 'if (ghNumber !== null) {')
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
