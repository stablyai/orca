import { describe, it, expect } from 'vitest'
import type { WorkspacePaneNode } from '../../../../shared/types'
import {
  computeWorkspaceSplitGeometry,
  resolveDividerRatioFromPointer
} from './workspace-split-frames'

describe('computeWorkspaceSplitGeometry', () => {
  it('splits a two-pane horizontal tree by ratio', () => {
    const layout: WorkspacePaneNode = {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'pane', worktreeId: 'a' },
      second: { type: 'pane', worktreeId: 'b' },
      ratio: 0.3
    }
    const { frameByWorktreeId, dividers } = computeWorkspaceSplitGeometry(layout)
    expect(frameByWorktreeId.get('a')).toEqual({ left: 0, top: 0, width: 30, height: 100 })
    expect(frameByWorktreeId.get('b')).toEqual({ left: 30, top: 0, width: 70, height: 100 })
    expect(dividers).toHaveLength(1)
    expect(dividers[0]).toMatchObject({
      path: [],
      direction: 'horizontal',
      linePosition: 30,
      crossStart: 0,
      crossLength: 100
    })
  })

  it('nests vertical splits inside horizontal ones with default ratio', () => {
    const layout: WorkspacePaneNode = {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'pane', worktreeId: 'a' },
      second: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'pane', worktreeId: 'b' },
        second: { type: 'pane', worktreeId: 'c' }
      }
    }
    const { frameByWorktreeId, dividers } = computeWorkspaceSplitGeometry(layout)
    expect(frameByWorktreeId.get('b')).toEqual({ left: 50, top: 0, width: 50, height: 50 })
    expect(frameByWorktreeId.get('c')).toEqual({ left: 50, top: 50, width: 50, height: 50 })
    const nested = dividers.find((divider) => divider.path.length === 1)
    expect(nested).toMatchObject({
      path: ['second'],
      direction: 'vertical',
      linePosition: 50,
      crossStart: 50,
      crossLength: 50
    })
  })
})

describe('resolveDividerRatioFromPointer', () => {
  const containerRect = { left: 100, top: 50, width: 1000, height: 500 }

  it('maps a pointer to a horizontal split ratio within the split region', () => {
    const { dividers } = computeWorkspaceSplitGeometry({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'pane', worktreeId: 'a' },
      second: { type: 'pane', worktreeId: 'b' }
    })
    // Pointer 40% across the container: (500 - 100) / 1000
    expect(
      resolveDividerRatioFromPointer(dividers[0], containerRect, { clientX: 500, clientY: 0 })
    ).toBeCloseTo(0.4)
  })

  it('maps a pointer to a nested vertical split ratio relative to its region', () => {
    const { dividers } = computeWorkspaceSplitGeometry({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'pane', worktreeId: 'a' },
      second: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'pane', worktreeId: 'b' },
        second: { type: 'pane', worktreeId: 'c' }
      }
    })
    const nested = dividers.find((divider) => divider.path.length === 1)!
    // Region is the full height; pointer 25% down: (175 - 50) / 500
    expect(
      resolveDividerRatioFromPointer(nested, containerRect, { clientX: 0, clientY: 175 })
    ).toBeCloseTo(0.25)
  })
})
