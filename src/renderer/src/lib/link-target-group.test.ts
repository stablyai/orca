import { describe, expect, it } from 'vitest'
import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import { resolveLinkTargetGroupPlan } from './link-target-group'

const leaf = (groupId: string): TabGroupLayoutNode => ({ type: 'leaf', groupId })
const split = (first: TabGroupLayoutNode, second: TabGroupLayoutNode): TabGroupLayoutNode => ({
  type: 'split',
  direction: 'horizontal',
  first,
  second,
  ratio: 0.5
})

const base = {
  enabled: true,
  workspaceId: 'ws-1',
  tabs: [{ entityId: 'ws-1', groupId: 'left' }],
  activeGroupId: 'left',
  firstGroupId: 'left',
  layout: split(leaf('left'), leaf('right'))
}

describe('resolveLinkTargetGroupPlan', () => {
  it('keeps default tab behavior when the setting is off', () => {
    expect(resolveLinkTargetGroupPlan({ ...base, enabled: false })).toEqual({
      kind: 'active-group'
    })
  })

  it('targets the sibling pane of the clicked page, not the active pane', () => {
    // Click originates in 'left' while 'right' is focused: still goes to the
    // clicked page's sibling, which is 'right'.
    expect(resolveLinkTargetGroupPlan({ ...base, activeGroupId: 'right' })).toEqual({
      kind: 'existing',
      groupId: 'right'
    })
  })

  it('targets the sibling when the clicked page lives in the second pane', () => {
    expect(
      resolveLinkTargetGroupPlan({
        ...base,
        tabs: [{ entityId: 'ws-1', groupId: 'right' }]
      })
    ).toEqual({ kind: 'existing', groupId: 'left' })
  })

  it('asks for a right split when the worktree has only one pane', () => {
    expect(resolveLinkTargetGroupPlan({ ...base, layout: leaf('left') })).toEqual({
      kind: 'split-right',
      sourceGroupId: 'left'
    })
  })

  it('falls back to the active group when the clicked page has no tab yet', () => {
    expect(resolveLinkTargetGroupPlan({ ...base, tabs: [] })).toEqual({
      kind: 'existing',
      groupId: 'right'
    })
  })

  it('keeps default behavior when no group can be resolved at all', () => {
    expect(
      resolveLinkTargetGroupPlan({
        ...base,
        tabs: [],
        activeGroupId: null,
        firstGroupId: null,
        layout: null
      })
    ).toEqual({ kind: 'active-group' })
  })
})
