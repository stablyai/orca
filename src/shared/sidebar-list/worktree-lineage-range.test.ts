import { describe, expect, it } from 'vitest'
import type { WorktreeOccurrence, WorktreeOccurrencePlan } from '../worktree-occurrence-plan'
import type { Worktree } from '../worktree/types'
import { buildWorktreeLineageRanges } from './worktree-lineage-range'

function row(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return { id, repoId: 'repo', hostId: 'local', ...overrides } as Worktree
}

/** One section: a parent at depth 0 with two children at depth 1. */
function plan(rows: readonly Worktree[], depths = [0, 1, 1]): WorktreeOccurrencePlan<Worktree> {
  const occurrences = rows.map((worktree, index): WorktreeOccurrence<Worktree> => ({
    key: `section:${worktree.id}`,
    row: worktree,
    sectionKey: 'section',
    placement: 'natural',
    sectionPath: { key: 'section' },
    depth: depths[index]!,
    childCount: index === 0 ? rows.length - 1 : 0,
    isLastChild: index === rows.length - 1,
    showProjectName: false
  }))
  return { bySection: new Map([['section', occurrences]]), preferredByIdentity: new Map() }
}

describe('buildWorktreeLineageRanges', () => {
  it('keeps the tree and ranges when a row is replaced without moving', () => {
    const rows = [row('parent'), row('a'), row('b')]
    const before = buildWorktreeLineageRanges(plan(rows))
    const replaced = row('a', { isUnread: true })
    const after = buildWorktreeLineageRanges(plan([rows[0]!, replaced, rows[2]!]))

    const parent = after.get('section:parent')!
    expect(parent).toBe(before.get('section:parent'))
    // The reused tree carries the new row so fallback reads see it, and names the index.
    expect(parent.tree.worktrees[1]).toBe(replaced)
    expect(parent.tree.replacedRows).toEqual([[1]])
  })

  it('rebuilds the tree when depth changes', () => {
    const rows = [row('parent'), row('a'), row('b')]
    const before = buildWorktreeLineageRanges(plan(rows))
    const after = buildWorktreeLineageRanges(plan([...rows], [0, 1, 2]))
    expect(after.get('section:parent')!.tree).not.toBe(before.get('section:parent')!.tree)
    expect(after.get('section:a')!.length).toBe(1)
  })
})
