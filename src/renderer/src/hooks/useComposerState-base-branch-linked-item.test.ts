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

describe('useComposerState base-branch picks preserve a linked task branch name', () => {
  it('gates the branch-name-override reset on there being no linked work item', () => {
    const section = sourceBetween(
      HOOK_SOURCE,
      'const handleBaseBranchChange = useCallback(',
      'const handleBaseBranchPrSelect = useCallback('
    )

    expect(section).toContain('setBaseBranch(next)')
    // Why: a Linear/Jira source's branch name is independent of the base it's
    // cut from — only a bare Start-from branch pick should wipe the override.
    expect(section).toContain('if (!linkedWorkItem) {')
    expect(section).toContain('setBranchNameOverride(undefined)')
    expect(section).toContain('setBranchNameOverridePreservesNameEdits(false)')
    expect(section).toContain('setReuseEligibleBranch(null)')
    expect(section).toContain('setReuseSelectedBranch(false)')
    expect(section).toContain("branchAutoNameRef.current = ''")
    // compareBaseRef/pushTarget/the GitHub PR start-point ref clear unconditionally.
    expect(section.indexOf('smartGitHubPrStartPointSelectionRef.current = null')).toBeLessThan(
      section.indexOf('if (!linkedWorkItem) {')
    )
    expect(section.indexOf('setCompareBaseRef(undefined)')).toBeLessThan(
      section.indexOf('if (!linkedWorkItem) {')
    )
    expect(section).toContain('[linkedWorkItem]')
  })
})
