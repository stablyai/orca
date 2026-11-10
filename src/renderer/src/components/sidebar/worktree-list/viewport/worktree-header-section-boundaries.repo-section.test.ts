import { describe, expect, it } from 'vitest'

import type { RenderRow } from '../listing/render-row'
import {
  getRepoSectionPreviewOffsetY,
  getRepoSectionRepoIdByRowIndex,
  shouldAnimateProjectHeaderDragRow
} from './worktree-header-section-boundaries'

function headerRow(key: string, repoId?: string): RenderRow {
  return {
    type: 'header',
    key,
    label: key,
    count: 1,
    repo: repoId ? { id: repoId } : undefined
  } as RenderRow
}

function sectionRow(type: Exclude<RenderRow['type'], 'header' | 'host-header'>): RenderRow {
  return { type, key: type } as RenderRow
}

const sectionRows: RenderRow[] = [
  headerRow('repo:a', 'a'),
  sectionRow('item'),
  sectionRow('lineage-group'),
  sectionRow('imported-worktrees-card'),
  sectionRow('pending-creation'),
  headerRow('repo:b', 'b'),
  sectionRow('new-external-worktrees-inbox'),
  sectionRow('folder-workspace'),
  headerRow('pinned'),
  sectionRow('item'),
  { type: 'host-header', key: 'host:local' } as RenderRow,
  sectionRow('item')
]

describe('repo section membership', () => {
  it('assigns every row under a project header to that project', () => {
    expect(getRepoSectionRepoIdByRowIndex(sectionRows)).toEqual([
      'a',
      'a',
      'a',
      'a',
      'a',
      'b',
      'b',
      'b',
      undefined,
      undefined,
      undefined,
      undefined
    ])
  })

  it('moves a whole section by its header offset so it cannot tear apart', () => {
    const sectionRepoIds = getRepoSectionRepoIdByRowIndex(sectionRows)
    const previewOffsetsByRepoId = new Map([['b', 32]])
    const offsets = sectionRows.map((_row, rowIndex) =>
      getRepoSectionPreviewOffsetY({
        repoSectionRepoIdByRowIndex: sectionRepoIds,
        rowIndex,
        previewOffsetsByRepoId
      })
    )

    expect(offsets).toEqual([0, 0, 0, 0, 0, 32, 32, 32, 0, 0, 0, 0])
  })

  it('moves every row in the dragged expanded section with the pointer', () => {
    const sectionRepoIds = getRepoSectionRepoIdByRowIndex(sectionRows)
    const offsets = sectionRows.map((_row, rowIndex) =>
      getRepoSectionPreviewOffsetY({
        repoSectionRepoIdByRowIndex: sectionRepoIds,
        rowIndex,
        previewOffsetsByRepoId: new Map([['b', -132]]),
        draggingRepoId: 'a',
        draggedSectionOffsetY: 48
      })
    )

    expect(offsets).toEqual([48, 48, 48, 48, 48, -132, -132, -132, 0, 0, 0, 0])
  })

  it('skips the transition on the section that is following the pointer', () => {
    const sectionRepoIds = getRepoSectionRepoIdByRowIndex(sectionRows)
    expect(
      shouldAnimateProjectHeaderDragRow({
        draggingRepoId: null,
        settling: false,
        repoSectionRepoIdByRowIndex: sectionRepoIds,
        rowIndex: 1
      })
    ).toBe(false)
    expect(
      shouldAnimateProjectHeaderDragRow({
        draggingRepoId: 'a',
        settling: false,
        repoSectionRepoIdByRowIndex: sectionRepoIds,
        rowIndex: 1
      })
    ).toBe(false)
    expect(
      shouldAnimateProjectHeaderDragRow({
        draggingRepoId: 'a',
        settling: false,
        repoSectionRepoIdByRowIndex: sectionRepoIds,
        rowIndex: 6
      })
    ).toBe(true)
    expect(
      shouldAnimateProjectHeaderDragRow({
        draggingRepoId: 'a',
        settling: true,
        repoSectionRepoIdByRowIndex: sectionRepoIds,
        rowIndex: 1
      })
    ).toBe(true)
  })
})
