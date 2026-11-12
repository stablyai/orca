import { describe, expect, it } from 'vitest'
import '../tab-groups/tab-order'
import type { CommandOf } from '../workspace-layout-command-types'
import { build, testContext, WS } from './workspace-layout-command.test-fixture'
import type { WorkspaceLayoutModel } from '../workspace-layout-model'

function setup() {
  const ctx = testContext()
  const { model, results } = build(
    ctx,
    Array.from({ length: 4 }, () => ({ type: 'createTerminalTab' as const, workspace: WS }))
  )
  const [h, a, b, c] = results.map((result) => result.tabId!)
  return { ctx, model, h: h!, a: a!, b: b!, c: c!, group: model.workspaces[WS]!.groups[0]!.id }
}

const orders = (model: WorkspaceLayoutModel) =>
  model.workspaces[WS]!.groups.map((group) => group.tabOrder)

const move = (fields: Omit<CommandOf<'moveTab'>, 'type' | 'workspace'>): CommandOf<'moveTab'> => ({
  type: 'moveTab',
  workspace: WS,
  ...fields
})

describe('moveTab anchor', () => {
  it('places right after the anchor, or first for null, whatever the index says', () => {
    const { ctx, model, h, a, b, c, group } = setup()
    const after = build(ctx, [move({ tabId: h, toGroupId: group, index: 0, afterTabId: b })], model)
    expect(orders(after.model)).toEqual([[a, b, h, c]])
    const first = build(
      ctx,
      [move({ tabId: c, toGroupId: group, index: 2, afterTabId: null })],
      model
    )
    expect(orders(first.model)).toEqual([[c, h, a, b]])
  })

  it('falls back to the index when the anchor is missing, the moved tab, or in another group', () => {
    const { ctx, model, h, a, b, c, group } = setup()
    for (const afterTabId of ['gone', c]) {
      const moved = build(ctx, [move({ tabId: c, toGroupId: group, index: 1, afterTabId })], model)
      expect(orders(moved.model)).toEqual([[h, c, a, b]])
    }
    const split = build(
      ctx,
      [{ type: 'splitGroup', workspace: WS, tabId: h, besideGroupId: group, direction: 'right' }],
      model
    )
    const right = split.results[0]!.groupId!
    // The anchor h is in the right group, not the target.
    const moved = build(
      ctx,
      [move({ tabId: c, toGroupId: group, index: 0, afterTabId: h })],
      split.model
    )
    expect(orders(moved.model)).toEqual([[c, a, b], [h]])
    const across = build(
      ctx,
      [move({ tabId: a, toGroupId: right, index: 0, afterTabId: h })],
      split.model
    )
    expect(orders(across.model)).toEqual([
      [b, c],
      [h, a]
    ])
  })
})
