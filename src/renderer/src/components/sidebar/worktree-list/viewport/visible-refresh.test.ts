import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { VirtualItem } from '@tanstack/react-virtual'
import type { WorktreeItemRow } from '../listing/renderable-rows'
import { makePRRefreshWorktree } from '@/store/github/github-slice-test-harness'
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

it('reports hidden descendants through an on-screen ancestor without requiring mounted child cards', () => {
  const parent = {
    ...row('parent'),
    lineageDescendantsHidden: true,
    lineageDescendantIdentities: [
      composeWorktreeHostIdentity('local', 'uncached-child'),
      composeWorktreeHostIdentity('ssh:box', 'stale-child')
    ]
  }
  expect(
    visibleReviewCardIds({
      enabled: true,
      renderRows: [parent],
      virtualItems: [virtualItem(0)],
      viewportTop: 0,
      viewportHeight: 100,
      isOnScreen: (id) => id === 'parent'
    })
  ).toEqual(['parent', 'uncached-child', 'stale-child'])
  expect(
    visibleReviewCardIds({
      enabled: true,
      renderRows: [parent],
      virtualItems: [virtualItem(0)],
      viewportTop: 100,
      viewportHeight: 100
    })
  ).toEqual([])
})
