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

describe('useComposerState clears stale start-point state on GitLab item selection', () => {
  it('clears baseBranch and pushTarget on both the issue short-circuit and the MR resolution path', () => {
    const section = sourceBetween(
      HOOK_SOURCE,
      'const handleSmartGitLabItemSelect = useCallback(',
      'const handleSmartBranchSelect = useCallback('
    )

    // Why: without this, selecting a GitLab issue/MR after a Start-from branch (or a
    // prior PR/MR) pick kept the old baseBranch/pushTarget — the workspace could branch
    // from the wrong place, or a stale fork pushTarget from an earlier GitHub PR could
    // leak into a GitLab create. Mirrors handleSmartGitHubItemSelect's
    // setBaseBranch/setPushTarget(undefined) on both sides of its type check.
    const shortCircuit = sourceBetween(section, "if (item.type !== 'mr' || !runRepo) {", '}')
    expect(shortCircuit).toContain('setBaseBranch(undefined)')
    expect(shortCircuit).toContain('setPushTarget(undefined)')

    const afterShortCircuit = section.slice(section.indexOf(shortCircuit) + shortCircuit.length)
    const mrPath = sourceBetween(afterShortCircuit, '', 'const itemRepoSettings =')
    expect(mrPath).toContain('setBaseBranch(undefined)')
    expect(mrPath).toContain('setPushTarget(undefined)')
  })

  it('ignores a stale resolveMrBase result from a superseded GitLab item pick', () => {
    const section = sourceBetween(
      HOOK_SOURCE,
      'const handleSmartGitLabItemSelect = useCallback(',
      'const handleSmartBranchSelect = useCallback('
    )

    // Why: resolveMrBase resolves async — without a per-call token, selecting a
    // second GitLab item while the first MR's resolution is still in flight let
    // the stale .then/.catch overwrite the newer selection's baseBranch,
    // pushTarget, and linked work item (mirrors the GitHub PR ref's guard).
    const invalidateAt = section.indexOf('invalidateSmartStartPointSelections()')
    const projectGroupCheckAt = section.indexOf('if (isProjectGroupTarget) {')
    expect(invalidateAt).toBeGreaterThanOrEqual(0)
    expect(invalidateAt).toBeLessThan(projectGroupCheckAt)

    const mintAt = section.indexOf('const mrStartPointSelection = {}')
    const assignAt = section.indexOf(
      'smartGitLabMrStartPointSelectionRef.current = mrStartPointSelection'
    )
    expect(mintAt).toBeGreaterThan(invalidateAt)
    expect(assignAt).toBeGreaterThan(mintAt)

    const thenSection = sourceBetween(section, '.then((result) => {', '.catch((error: unknown) => {')
    expect(thenSection).toContain(
      'if (smartGitLabMrStartPointSelectionRef.current !== mrStartPointSelection) {'
    )
    const catchSection = section.slice(section.indexOf(thenSection) + thenSection.length)
    expect(catchSection).toContain(
      'if (smartGitLabMrStartPointSelectionRef.current !== mrStartPointSelection) {'
    )
  })
})

describe('useComposerState invalidates both PR/MR start-point refs together', () => {
  it('defines one helper that nulls the GitHub PR and GitLab MR refs together', () => {
    const helper = sourceBetween(
      HOOK_SOURCE,
      'const invalidateSmartStartPointSelections = useCallback((): void => {',
      '}, [])'
    )
    expect(helper).toContain('smartGitHubPrStartPointSelectionRef.current = null')
    expect(helper).toContain('smartGitLabMrStartPointSelectionRef.current = null')
  })

  it('calls the shared invalidator from every competing selection, not just a GitLab item pick', () => {
    // Why: a pending GitLab MR (or GitHub PR) base resolution is async — any other
    // action that changes what's selected (a different provider's item, a manual
    // base/branch pick, a repo change, or clearing the source) must invalidate it
    // too, or the stale .then/.catch can still land and restore old state.
    const handlers = [
      'const handleSelectLinkedItem = useCallback(',
      'const handleRemoveLinkedWorkItem = useCallback((): void => {',
      'const handleRepoChange = useCallback(',
      'const handleFolderSourceRepoChange = useCallback(',
      'const handleBaseBranchChange = useCallback(',
      'const handleSmartGitHubItemSelect = useCallback(',
      'const handleSmartGitLabItemSelect = useCallback(',
      'const handleSmartBranchSelect = useCallback(',
      'const handleSmartLinearIssueSelect = useCallback(',
      'const handleSmartJiraIssueSelect = useCallback(',
      'const handleClearSmartNameSelection = useCallback((): void => {'
    ]

    for (let i = 0; i < handlers.length; i += 1) {
      const start = handlers[i]
      const end = handlers[i + 1] ?? 'const smartNameSelection = useMemo<SmartWorkspaceNameSelection | null>('
      const section = sourceBetween(HOOK_SOURCE, start, end)
      expect(section).toContain('invalidateSmartStartPointSelections()')
    }
  })
})
