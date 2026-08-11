import { describe, expect, it } from 'vitest'

import {
  getRepoSectionPreviewOffsetY,
  getRepoSectionRepoIdByRowIndex
} from './worktree-header-section-boundaries'
import type { RenderRow } from './worktree-list-virtual-rows'
import type { Repo } from '../../../../shared/types'

// Why: the section mapping only reads a row's type and a header's repo, so the
// fixtures stay minimal instead of restating the full row model.
function headerRow(key: string, repoId?: string): RenderRow {
  return {
    type: 'header',
    key,
    label: key,
    count: 1,
    tone: '',
    repo: repoId ? ({ id: repoId } as Repo) : undefined
  }
}

function sectionRow(type: Exclude<RenderRow['type'], 'header' | 'host-header'>): RenderRow {
  return { type, key: type } as unknown as RenderRow
}

const ROWS: RenderRow[] = [
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
  { type: 'host-header', key: 'host:local' } as unknown as RenderRow,
  sectionRow('item')
]

describe('repo section membership', () => {
  it('assigns every row under a project header to that project', () => {
    expect(getRepoSectionRepoIdByRowIndex(ROWS)).toEqual([
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
    const sectionRepoIds = getRepoSectionRepoIdByRowIndex(ROWS)
    const previewOffsetsByRepoId = new Map([['b', 32]])
    const offsets = ROWS.map((_row, rowIndex) =>
      getRepoSectionPreviewOffsetY({
        repoSectionRepoIdByRowIndex: sectionRepoIds,
        rowIndex,
        previewOffsetsByRepoId
      })
    )

    // Repo b's header and both of its rows shift together; nothing else moves.
    expect(offsets).toEqual([0, 0, 0, 0, 0, 32, 32, 32, 0, 0, 0, 0])
  })

  it('moves every row in the dragged expanded section with the pointer', () => {
    const sectionRepoIds = getRepoSectionRepoIdByRowIndex(ROWS)
    const offsets = ROWS.map((_row, rowIndex) =>
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
})
