import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isSleepingSweepExemptWorkspace } from './sidebar/visible-worktrees'
import type { Worktree } from '../../../shared/worktree/types'

const source = readFileSync(join(__dirname, 'WorktreeJumpPalette.tsx'), 'utf8')

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-main',
    repoId: 'repo1',
    path: '/tmp/repo1',
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    displayName: 'main',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

describe('Cmd+J empty-query "Hide sleeping" pass (#8873)', () => {
  // Why source-level: the palette re-implements the sidebar's filter pass
  // inline, so the only structural guarantee that the two agree is that both
  // call the shared predicate. A behavioral copy here would not catch a
  // hand-rolled duplicate creeping back in.
  it('routes the sleeping sweep through the shared exemption predicate', () => {
    const start = source.indexOf('const emptyQueryVisibleWorktrees = useMemo(')
    expect(start).toBeGreaterThanOrEqual(0)
    const end = source.indexOf('const { visibleWorktreesForState', start)
    const filterPass = source.slice(start, end)

    expect(filterPass).toContain(
      '!isSleepingSweepExemptWorkspace(worktree, alwaysShowDefaultBranchWorkspace)'
    )
    expect(filterPass).toContain('alwaysShowDefaultBranchWorkspace,')
  })

  it('reads the flag from the same store field the sidebar uses', () => {
    expect(source).toContain(
      'const alwaysShowDefaultBranchWorkspace = useAppStore((s) => s.alwaysShowDefaultBranchWorkspace)'
    )
  })

  it('exempts a project entry point by default and honours an explicit opt-out', () => {
    const main = makeWorktree()

    expect(isSleepingSweepExemptWorkspace(main, undefined)).toBe(true)
    expect(isSleepingSweepExemptWorkspace(main, true)).toBe(true)
    expect(isSleepingSweepExemptWorkspace(main, false)).toBe(false)
  })

  it('never exempts a non-main workspace', () => {
    const feature = makeWorktree({ id: 'wt-feature', isMainWorktree: false })

    expect(isSleepingSweepExemptWorkspace(feature, true)).toBe(false)
    expect(isSleepingSweepExemptWorkspace(feature, undefined)).toBe(false)
  })
})
