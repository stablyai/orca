import { describe, expect, it } from 'vitest'
import type { SourceControlVisibleRow } from '../../../../../../shared/source-control/listing/source-control-visible-row'
import {
  getAdjacentWorktreeDiffRow,
  isWorktreeDiffNavigationRow
} from './worktree-diff-file-navigation'

const row = (
  area: 'unstaged' | 'staged' | 'untracked',
  path: string,
  conflictKind?: 'both_modified'
): SourceControlVisibleRow => ({
  key: `${area}::${path}`,
  entry: { path, status: 'modified', area, ...(conflictKind ? { conflictKind } : {}) }
})

const rows = [row('unstaged', 'src/a.ts'), row('staged', 'src/b.ts'), row('untracked', 'src/c.ts')]

describe('worktree diff file navigation', () => {
  it('steps to the displayed neighbor across staging areas in both directions', () => {
    const args = { rows, previousKeys: null }

    expect(
      getAdjacentWorktreeDiffRow({ ...args, currentKey: 'unstaged::src/a.ts', direction: 'next' })
    ).toMatchObject({ key: 'staged::src/b.ts' })
    expect(
      getAdjacentWorktreeDiffRow({
        ...args,
        currentKey: 'untracked::src/c.ts',
        direction: 'previous'
      })
    ).toMatchObject({ key: 'staged::src/b.ts' })
  })

  it('stops at the list ends instead of wrapping across files', () => {
    const args = { rows, previousKeys: null }

    expect(
      getAdjacentWorktreeDiffRow({ ...args, currentKey: 'staged::src/b.ts', direction: 'next' })
    ).toMatchObject({ key: 'untracked::src/c.ts' })
    expect(
      getAdjacentWorktreeDiffRow({ ...args, currentKey: 'untracked::src/c.ts', direction: 'next' })
    ).toBeNull()
    expect(
      getAdjacentWorktreeDiffRow({
        ...args,
        currentKey: 'unstaged::src/a.ts',
        direction: 'previous'
      })
    ).toBeNull()
  })

  it('reaches the sole remaining row after the current row left the list', () => {
    expect(
      getAdjacentWorktreeDiffRow({
        rows: [row('unstaged', 'src/b.ts')],
        currentKey: 'unstaged::src/a.ts',
        previousKeys: ['unstaged::src/a.ts', 'unstaged::src/b.ts'],
        direction: 'next'
      })
    ).toMatchObject({ key: 'unstaged::src/b.ts' })
    expect(
      getAdjacentWorktreeDiffRow({
        rows: [row('unstaged', 'src/b.ts')],
        currentKey: 'unstaged::src/b.ts',
        previousKeys: ['unstaged::src/a.ts', 'unstaged::src/b.ts'],
        direction: 'next'
      })
    ).toBeNull()
  })

  it('continues from where a vanished row last sat, skipping the same file other side', () => {
    // Staged first: p was partly staged and had working-tree changes; it is now fully staged.
    const previousKeys = ['staged::src/p.ts', 'unstaged::src/p.ts', 'staged::src/q.ts']

    expect(
      getAdjacentWorktreeDiffRow({
        rows: [row('staged', 'src/p.ts'), row('staged', 'src/q.ts')],
        currentKey: 'unstaged::src/p.ts',
        previousKeys,
        direction: 'next'
      })
    ).toMatchObject({ key: 'staged::src/q.ts' })
    expect(
      getAdjacentWorktreeDiffRow({
        rows: [row('staged', 'src/p.ts'), row('staged', 'src/q.ts')],
        currentKey: 'unstaged::src/p.ts',
        previousKeys,
        direction: 'previous'
      })
    ).toBeNull()
  })

  it('declines a vanished row it never saw', () => {
    expect(
      getAdjacentWorktreeDiffRow({
        rows,
        currentKey: 'unstaged::src/never-opened.ts',
        previousKeys: null,
        direction: 'next'
      })
    ).toBeNull()
    expect(
      getAdjacentWorktreeDiffRow({
        rows,
        currentKey: 'unstaged::src/never-opened.ts',
        previousKeys: ['unstaged::src/other.ts'],
        direction: 'previous'
      })
    ).toBeNull()
  })

  it('keeps conflict rows outside the sweep', () => {
    expect(isWorktreeDiffNavigationRow(row('unstaged', 'src/a.ts'))).toBe(true)
    expect(isWorktreeDiffNavigationRow(row('unstaged', 'src/conflict.ts', 'both_modified'))).toBe(
      false
    )
  })
})
