import { describe, expect, it } from 'vitest'
import { build, testContext, WS } from './workspace-layout-command.test-fixture'
import type { WorkspaceLayoutModel } from './workspace-layout-model'

function setup() {
  const ctx = testContext()
  const { model, results } = build(ctx, [
    { type: 'createTerminalTab', workspace: WS },
    { type: 'createTerminalTab', workspace: WS },
    { type: 'createTerminalTab', workspace: WS }
  ])
  const [a, b, c] = results.map((result) => result!.tabId!)
  const pinned = build(
    ctx,
    [
      { type: 'setTabProps', workspace: WS, tabId: a!, isPinned: true },
      { type: 'setTabProps', workspace: WS, tabId: b!, isPinned: true }
    ],
    model
  )
  return { ctx, model: pinned.model, a: a!, b: b!, c: c! }
}

const order = (model: WorkspaceLayoutModel) => model.workspaces[WS]!.groups[0]!.tabOrder
const pinOf = (model: WorkspaceLayoutModel, tabId: string) =>
  model.workspaces[WS]!.tabs.find((tab) => tab.id === tabId)?.isPinned === true

describe('moveTab with a pin', () => {
  it('pins the tab where the move puts it, without the pin moving it again', () => {
    const { ctx, model, a, b, c } = setup()
    const groupId = model.workspaces[WS]!.groups[0]!.id

    const moved = build(
      ctx,
      [{ type: 'moveTab', workspace: WS, tabId: c, toGroupId: groupId, index: 1, isPinned: true }],
      model
    ).model

    expect(order(moved)).toEqual([a, c, b])
    expect(pinOf(moved, c)).toBe(true)
  })

  it('unpins the tab where the move puts it', () => {
    const { ctx, model, a, b, c } = setup()
    const groupId = model.workspaces[WS]!.groups[0]!.id
    const unpinnedB = build(
      ctx,
      [{ type: 'setTabProps', workspace: WS, tabId: b, isPinned: false }],
      model
    ).model

    const moved = build(
      ctx,
      [{ type: 'moveTab', workspace: WS, tabId: a, toGroupId: groupId, index: 1, isPinned: false }],
      unpinnedB
    ).model

    expect(order(moved)).toEqual([b, a, c])
    expect(pinOf(moved, a)).toBe(false)
  })

  it('a move without a pin leaves the pin as it was', () => {
    const { ctx, model, a, b, c } = setup()
    const groupId = model.workspaces[WS]!.groups[0]!.id

    const moved = build(
      ctx,
      [{ type: 'moveTab', workspace: WS, tabId: b, toGroupId: groupId, index: 0 }],
      model
    ).model

    expect(order(moved)).toEqual([b, a, c])
    expect(pinOf(moved, b)).toBe(true)
  })
})
