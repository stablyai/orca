import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HOOK_SOURCE = readFileSync(join(__dirname, 'useComposerState.ts'), 'utf8')

function sourceBetween(source: string, startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('useComposerState clears a stale base branch on GitLab item selection', () => {
  it('clears baseBranch on both the issue short-circuit and the MR resolution path', () => {
    const section = sourceBetween(
      HOOK_SOURCE,
      'const handleSmartGitLabItemSelect = useCallback(',
      'const handleSmartBranchSelect = useCallback('
    )

    // Why: without this, selecting a GitLab issue/MR after a Start-from branch (or a
    // prior PR/MR) pick kept the old baseBranch and would branch the workspace from
    // the wrong place — mirrors handleSmartGitHubItemSelect's setBaseBranch(undefined)
    // on both sides of its type check.
    const shortCircuit = sourceBetween(
      section,
      "if (item.type !== 'mr' || !runRepo) {",
      '}'
    )
    expect(shortCircuit).toContain('setBaseBranch(undefined)')

    const afterShortCircuit = section.slice(section.indexOf(shortCircuit) + shortCircuit.length)
    const mrPath = sourceBetween(afterShortCircuit, '', 'const itemRepoSettings =')
    expect(mrPath).toContain('setBaseBranch(undefined)')
  })
})
