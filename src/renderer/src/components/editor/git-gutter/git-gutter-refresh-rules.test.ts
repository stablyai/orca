import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../../../shared/types'
import { computeGitGutterBaselineToken, isGitGutterEligible } from './git-gutter-refresh-rules'

function entry(overrides: Partial<GitStatusEntry> = {}): GitStatusEntry {
  return { path: 'src/a.ts', status: 'modified', area: 'unstaged', ...overrides }
}

describe('isGitGutterEligible', () => {
  const base = {
    enabled: true,
    mode: 'edit' as const,
    relativePath: 'src/a.ts',
    statusEntries: [entry()],
    isGitBackedWorktree: true
  }

  it('allows a tracked, modified file in an edit tab', () => {
    expect(isGitGutterEligible(base)).toBe(true)
  })

  it('allows a tracked file with no status entry at all', () => {
    expect(isGitGutterEligible({ ...base, statusEntries: [] })).toBe(true)
  })

  it('refuses when the setting is off', () => {
    expect(isGitGutterEligible({ ...base, enabled: false })).toBe(false)
  })

  it('refuses on diff and preview tabs', () => {
    expect(isGitGutterEligible({ ...base, mode: 'diff' })).toBe(false)
    expect(isGitGutterEligible({ ...base, mode: 'markdown-preview' })).toBe(false)
  })

  it('allows untracked files, which read as entirely added against an empty HEAD', () => {
    expect(
      isGitGutterEligible({
        ...base,
        statusEntries: [entry({ status: 'untracked', area: 'untracked' })]
      })
    ).toBe(true)
  })

  it('ignores status entries belonging to other files', () => {
    expect(
      isGitGutterEligible({
        ...base,
        statusEntries: [entry({ path: 'src/other.ts', status: 'untracked', area: 'untracked' })]
      })
    ).toBe(true)
  })

  it('refuses while the path is an unresolved conflict', () => {
    expect(
      isGitGutterEligible({
        ...base,
        statusEntries: [entry({ conflictKind: 'both_modified', conflictStatus: 'unresolved' })]
      })
    ).toBe(false)
  })

  it('allows a conflict the user already resolved locally', () => {
    expect(
      isGitGutterEligible({
        ...base,
        statusEntries: [
          entry({ conflictKind: 'both_modified', conflictStatus: 'resolved_locally' })
        ]
      })
    ).toBe(true)
  })

  it('ignores an unresolved conflict belonging to another file', () => {
    expect(
      isGitGutterEligible({
        ...base,
        statusEntries: [
          entry(),
          entry({
            path: 'src/other.ts',
            conflictKind: 'both_modified',
            conflictStatus: 'unresolved'
          })
        ]
      })
    ).toBe(true)
  })

  // Why allowed: the git-backed gate already proves this is a repo, so an unloaded status is
  // just "not polled yet" — waiting for it would delay the marks on every cold open.
  it('allows a file whose status has not loaded yet', () => {
    expect(isGitGutterEligible({ ...base, statusEntries: undefined })).toBe(true)
  })

  it('refuses when the worktree is not git-backed', () => {
    expect(isGitGutterEligible({ ...base, isGitBackedWorktree: false })).toBe(false)
  })

  // Why these are allowed: HEAD has no blob at the path, so the whole file reads as added.
  // That is the intended signal — "none of this is committed yet" — not noise to suppress.
  it('allows a staged-added file', () => {
    expect(
      isGitGutterEligible({
        ...base,
        statusEntries: [entry({ status: 'added', area: 'staged' })]
      })
    ).toBe(true)
  })

  it('allows renamed and copied files', () => {
    expect(
      isGitGutterEligible({
        ...base,
        statusEntries: [entry({ status: 'renamed', area: 'staged', oldPath: 'src/old.ts' })]
      })
    ).toBe(true)
    expect(
      isGitGutterEligible({
        ...base,
        statusEntries: [entry({ status: 'copied', area: 'staged', oldPath: 'src/source.ts' })]
      })
    ).toBe(true)
  })

  it('refuses on conflict-review and check-details tabs', () => {
    expect(isGitGutterEligible({ ...base, mode: 'conflict-review' })).toBe(false)
    expect(isGitGutterEligible({ ...base, mode: 'check-details' })).toBe(false)
  })
})

describe('computeGitGutterBaselineToken', () => {
  const base = {
    worktreeId: 'wt-1',
    relativePath: 'src/a.ts',
    headSha: 'abc123',
    statusEntries: [entry()]
  }

  it('is stable for unchanged inputs', () => {
    expect(computeGitGutterBaselineToken(base)).toBe(computeGitGutterBaselineToken({ ...base }))
  })

  it('changes when HEAD moves', () => {
    expect(computeGitGutterBaselineToken({ ...base, headSha: 'def456' })).not.toBe(
      computeGitGutterBaselineToken(base)
    )
  })

  it('changes when the file gets staged', () => {
    expect(
      computeGitGutterBaselineToken({ ...base, statusEntries: [entry({ area: 'staged' })] })
    ).not.toBe(computeGitGutterBaselineToken(base))
  })

  it('changes when the file stops being dirty', () => {
    expect(computeGitGutterBaselineToken({ ...base, statusEntries: [] })).not.toBe(
      computeGitGutterBaselineToken(base)
    )
  })

  it('changes when the file identity changes', () => {
    expect(computeGitGutterBaselineToken({ ...base, relativePath: 'src/b.ts' })).not.toBe(
      computeGitGutterBaselineToken(base)
    )
    expect(computeGitGutterBaselineToken({ ...base, worktreeId: 'wt-2' })).not.toBe(
      computeGitGutterBaselineToken(base)
    )
  })

  it('does not change when an unrelated file changes', () => {
    expect(
      computeGitGutterBaselineToken({
        ...base,
        statusEntries: [entry(), entry({ path: 'src/other.ts' })]
      })
    ).toBe(computeGitGutterBaselineToken(base))
  })

  it('does not collide when a space could be read as either a worktreeId or a path boundary', () => {
    // A naive `[worktreeId, relativePath, ...].join(' ')` would make ('wt', 'a b') and
    // ('wt a', 'b') both render as "wt a b ...".
    const spaceInPath = computeGitGutterBaselineToken({
      worktreeId: 'wt',
      relativePath: 'a b',
      headSha: 'h',
      statusEntries: []
    })
    const spaceInWorktreeId = computeGitGutterBaselineToken({
      worktreeId: 'wt a',
      relativePath: 'b',
      headSha: 'h',
      statusEntries: []
    })
    expect(spaceInPath).not.toBe(spaceInWorktreeId)
  })

  it('incorporates both a staged and an unstaged entry for the same path, order-independently', () => {
    const staged = entry({ area: 'staged' })
    const unstaged = entry({ area: 'unstaged' })
    const forward = computeGitGutterBaselineToken({
      ...base,
      statusEntries: [staged, unstaged]
    })
    const reversed = computeGitGutterBaselineToken({
      ...base,
      statusEntries: [unstaged, staged]
    })
    expect(forward).toBe(reversed)
    expect(forward).not.toBe(computeGitGutterBaselineToken({ ...base, statusEntries: [staged] }))
    expect(forward).not.toBe(computeGitGutterBaselineToken({ ...base, statusEntries: [unstaged] }))
  })
})
