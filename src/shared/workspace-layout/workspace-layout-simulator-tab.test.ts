import { describe, expect, it } from 'vitest'
import { applyLayoutCommand } from './workspace-layout-commands'
import type { CommandOf } from './workspace-layout-command-types'
import { build, testContext, WS } from './workspace-layout-command.test-fixture'

const drawn = (
  fields: Partial<CommandOf<'openSimulatorTab'>> = {}
): CommandOf<'openSimulatorTab'> => ({
  type: 'openSimulatorTab',
  workspace: WS,
  tabId: 'sim-1',
  ...fields
})

describe('a simulator tab a window drew', () => {
  it('keeps the window’s id, group and creation time in a workspace main holds no group of', () => {
    const { model, results } = build(testContext(), [drawn({ groupId: 'g1', createdAt: 7 })])
    expect(results[0]?.tabId).toBe('sim-1')
    expect(model.workspaces[WS]?.groups).toEqual([{ id: 'g1', tabOrder: ['sim-1'] }])
    expect(model.workspaces[WS]?.tabs).toEqual([
      {
        id: 'sim-1',
        entityId: 'sim-1',
        kind: 'simulator',
        createdAt: 7,
        customTitle: null,
        color: null
      }
    ])
  })

  it('changes nothing when sent again, and refuses an id another tab holds', () => {
    const ctx = testContext()
    const { model, results } = build(ctx, [{ type: 'createTerminalTab', workspace: WS }, drawn()])
    const again = applyLayoutCommand(model, drawn(), ctx)
    expect(again.ok && again.model).toEqual(model)
    const taken = applyLayoutCommand(model, drawn({ tabId: results[0]!.tabId! }), ctx)
    expect(taken.ok ? 'applied' : taken.code).toBe('tab_exists')
  })

  it('refuses a group main does not hold beside the groups it does', () => {
    const ctx = testContext()
    const { model } = build(ctx, [{ type: 'createTerminalTab', workspace: WS }])
    const placed = applyLayoutCommand(model, drawn({ groupId: 'elsewhere' }), ctx)
    expect(placed.ok ? 'applied' : placed.code).toBe('group_not_found')
  })

  it('takes its place after the tab the window drew it beside', () => {
    const ctx = testContext()
    const { model, results } = build(ctx, [
      { type: 'createTerminalTab', workspace: WS },
      { type: 'createTerminalTab', workspace: WS }
    ])
    const first = results[0]!.tabId!
    const placed = build(ctx, [drawn({ afterTabId: first })], model).model
    expect(placed.workspaces[WS]?.groups[0]?.tabOrder).toEqual([first, 'sim-1', results[1]!.tabId!])
  })

  it('opens into the new split group the window made for it, and a close collapses it', () => {
    const ctx = testContext()
    const { model } = build(ctx, [{ type: 'createTerminalTab', workspace: WS }])
    const besideGroupId = model.workspaces[WS]!.groups[0]!.id
    const split = build(
      ctx,
      [drawn({ groupId: 'g2', split: { besideGroupId, direction: 'right' } })],
      model
    ).model
    expect(split.workspaces[WS]?.groupLayout).toMatchObject({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: besideGroupId },
      second: { type: 'leaf', groupId: 'g2' }
    })
    const closed = build(
      ctx,
      [{ type: 'closeTabs', workspace: WS, tabIds: ['sim-1'], force: true }],
      split
    ).model
    expect(closed.workspaces[WS]?.groups.map((group) => group.id)).toEqual([besideGroupId])
  })
})
