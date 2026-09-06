import { describe, expect, it } from 'vitest'
import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import { resolveSideGroupPlacement, resolveSourceGroupId } from './side-group-placement'

const leaf = (groupId: string): TabGroupLayoutNode => ({ type: 'leaf', groupId })
const split = (
  first: TabGroupLayoutNode,
  second: TabGroupLayoutNode,
  direction: 'horizontal' | 'vertical' = 'horizontal'
): TabGroupLayoutNode => ({ type: 'split', direction, first, second, ratio: 0.5 })

describe('resolveSourceGroupId', () => {
  it('prefers the caller-supplied group over the active group', () => {
    expect(
      resolveSourceGroupId({
        requestedGroupId: 'g-req',
        activeGroupId: 'g-act',
        fallbackGroupId: 'g-first'
      })
    ).toBe('g-req')
  })

  it('falls back to the active group, then the first group', () => {
    expect(
      resolveSourceGroupId({
        requestedGroupId: null,
        activeGroupId: 'g-act',
        fallbackGroupId: 'g-first'
      })
    ).toBe('g-act')
    expect(
      resolveSourceGroupId({
        requestedGroupId: null,
        activeGroupId: null,
        fallbackGroupId: 'g-first'
      })
    ).toBe('g-first')
  })

  it('returns null when no group can be resolved', () => {
    expect(
      resolveSourceGroupId({ requestedGroupId: null, activeGroupId: null, fallbackGroupId: null })
    ).toBeNull()
  })
})

describe('resolveSideGroupPlacement', () => {
  it('reuses the existing sibling group when the layout is already split', () => {
    expect(
      resolveSideGroupPlacement({
        layout: split(leaf('left'), leaf('right')),
        sourceGroupId: 'left'
      })
    ).toEqual({ kind: 'existing', groupId: 'right' })
  })

  it('reuses the sibling when the source is the second pane', () => {
    expect(
      resolveSideGroupPlacement({
        layout: split(leaf('left'), leaf('right')),
        sourceGroupId: 'right'
      })
    ).toEqual({ kind: 'existing', groupId: 'left' })
  })

  it('asks for a right split when the worktree has a single pane', () => {
    expect(resolveSideGroupPlacement({ layout: leaf('only'), sourceGroupId: 'only' })).toEqual({
      kind: 'split-right'
    })
  })

  it('asks for a right split when no layout has been persisted yet', () => {
    expect(resolveSideGroupPlacement({ layout: null, sourceGroupId: 'only' })).toEqual({
      kind: 'split-right'
    })
  })

  it('resolves the nearest layout sibling under nested splits', () => {
    // (a | (b | c)) — b's sibling is c, not a.
    const layout = split(leaf('a'), split(leaf('b'), leaf('c')))
    expect(resolveSideGroupPlacement({ layout, sourceGroupId: 'b' })).toEqual({
      kind: 'existing',
      groupId: 'c'
    })
  })

  it('treats a subtree sibling as reusable rather than forcing a new split', () => {
    // a's sibling subtree is (b | c); reuse its first leaf instead of splitting again.
    const layout = split(leaf('a'), split(leaf('b'), leaf('c')))
    expect(resolveSideGroupPlacement({ layout, sourceGroupId: 'a' })).toEqual({
      kind: 'existing',
      groupId: 'b'
    })
  })

  it('asks for a right split when the source group is absent from the layout', () => {
    expect(
      resolveSideGroupPlacement({ layout: split(leaf('x'), leaf('y')), sourceGroupId: 'missing' })
    ).toEqual({ kind: 'split-right' })
  })
})
