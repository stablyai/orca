import type { VirtualItem } from '@tanstack/react-virtual'
import type { WorktreeItemRow } from '../listing/renderable-rows'
import { makePRRefreshWorktree } from '@/store/slices/github-slice-test-harness'
import { describe, expect, it } from 'vitest'

import { visibleReviewCardIds } from './use-visible-review-refresh'

function row(id: string): WorktreeItemRow {
  return {
    type: 'item',
    rowKey: id,
    sectionKey: 'all',
    worktree: makePRRefreshWorktree({ id }),
    repo: {
      id: 'repo-1',
      path: '/repo',
      displayName: 'repo',
      badgeColor: '',
      addedAt: 1,
      kind: 'git'
    },
    depth: 0,
    groupDepth: 0,
    isLastLineageChild: true,
    lineageChildCount: 0
  }
}
function virtualItem(index: number): VirtualItem {
  return { key: index, index, start: index * 100, end: (index + 1) * 100, size: 100, lane: 0 }
}

describe('actual visible review cards', () => {
  it('excludes overscan rows and exact viewport boundaries', () => {
    expect(
      visibleReviewCardIds({
        enabled: true,
        renderRows: [row('above'), row('visible'), row('below')],
        virtualItems: [0, 1, 2].map(virtualItem),
        viewportTop: 100,
        viewportHeight: 100
      })
    ).toEqual(['visible'])
  })
})
