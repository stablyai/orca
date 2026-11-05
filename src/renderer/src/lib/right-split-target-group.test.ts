import { describe, expect, it, vi } from 'vitest'
import { resolveRightSplitTargetGroupId } from './right-split-target-group'

const leaf = (groupId: string) => ({ type: 'leaf', groupId }) as const
const split = (first: unknown, second: unknown) =>
  ({ type: 'split', direction: 'horizontal', first, second, ratio: 0.5 }) as const

function state(overrides: Record<string, unknown> = {}) {
  return {
    layoutByWorktree: { w: leaf('g1') },
    activeGroupIdByWorktree: { w: 'g1' },
    groupsByWorktree: { w: [{ id: 'g1' }] },
    createEmptySplitGroup: vi.fn(() => 'gNew'),
    ...overrides
  }
}

describe('resolveRightSplitTargetGroupId', () => {
  it('creates a right split when the worktree shows one group', () => {
    const s = state()
    expect(resolveRightSplitTargetGroupId(s, 'w', 'g1', { activate: false })).toBe('gNew')
    expect(s.createEmptySplitGroup).toHaveBeenCalledWith('w', 'g1', 'right', { activate: false })
  })

  it('reuses the nearest right sibling so repeated opens share one pane', () => {
    const s = state({ layoutByWorktree: { w: split(leaf('g1'), leaf('g2')) } })
    expect(resolveRightSplitTargetGroupId(s, 'w', 'g1', { activate: false })).toBe('g2')
    expect(s.createEmptySplitGroup).not.toHaveBeenCalled()
  })

  it('falls back to the active group when no source group is given', () => {
    const s = state()
    resolveRightSplitTargetGroupId(s, 'w', null, { activate: false })
    expect(s.createEmptySplitGroup).toHaveBeenCalledWith('w', 'g1', 'right', { activate: false })
  })

  it('returns null when the worktree has no group at all', () => {
    const s = state({ activeGroupIdByWorktree: {}, groupsByWorktree: { w: [] } })
    expect(resolveRightSplitTargetGroupId(s, 'w', null, { activate: false })).toBeNull()
    expect(s.createEmptySplitGroup).not.toHaveBeenCalled()
  })

  it('passes activate through for callers that want the split focused', () => {
    const s = state()
    resolveRightSplitTargetGroupId(s, 'w', 'g1', { activate: true })
    expect(s.createEmptySplitGroup).toHaveBeenCalledWith('w', 'g1', 'right', { activate: true })
  })

  it('forwards a silent mint to createEmptySplitGroup', () => {
    const s = state()
    resolveRightSplitTargetGroupId(s, 'w', 'g1', { activate: false, recordInteraction: false })
    expect(s.createEmptySplitGroup).toHaveBeenCalledWith('w', 'g1', 'right', {
      activate: false,
      recordInteraction: false
    })
  })
})
