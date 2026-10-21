import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyLayoutCommand } from './workspace-layout-commands'
import type { CommandOf } from './workspace-layout-command-types'
import { build, emptyModel, testContext, WS } from './workspace-layout-command.test-fixture'

const switchState = vi.hoisted(() => ({ layoutOwnerIsMain: true }))

vi.mock('../layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return switchState.layoutOwnerIsMain
  }
}))

beforeEach(() => {
  switchState.layoutOwnerIsMain = true
})

const drawn = (
  fields: Partial<CommandOf<'openAgentSessionTab'>> = {}
): CommandOf<'openAgentSessionTab'> => ({
  type: 'openAgentSessionTab',
  workspace: WS,
  tabId: 'structured-agent-session-chat-1',
  sessionId: 'chat-1',
  agent: 'codex',
  ...fields
})

describe('a chat tab a window drew', () => {
  it('keeps the window’s id, group and creation time in a workspace main holds no group of', () => {
    const { model, results } = build(testContext(), [drawn({ groupId: 'g1', createdAt: 7 })])
    expect(results[0]?.tabId).toBe('structured-agent-session-chat-1')
    expect(model.workspaces[WS]?.groups).toEqual([
      { id: 'g1', tabOrder: ['structured-agent-session-chat-1'] }
    ])
    expect(model.workspaces[WS]?.tabs[0]).toMatchObject({ createdAt: 7, entityId: 'chat-1' })
  })

  it('changes nothing when sent again, and refuses an id another tab holds', () => {
    const ctx = testContext()
    const { model } = build(ctx, [drawn()])
    const again = applyLayoutCommand(model, drawn(), ctx)
    expect(again.ok && again.model).toEqual(model)
    const other = applyLayoutCommand(model, drawn({ sessionId: 'chat-2' }), ctx)
    expect(other.ok ? 'applied' : other.code).toBe('tab_exists')
  })

  it('takes its place after the tab the window drew it beside', () => {
    const ctx = testContext()
    const { model, results } = build(ctx, [
      { type: 'createTerminalTab', workspace: WS },
      { type: 'createTerminalTab', workspace: WS }
    ])
    const first = results[0]!.tabId!
    const placed = build(ctx, [drawn({ afterTabId: first })], model).model
    expect(placed.workspaces[WS]?.groups[0]?.tabOrder).toEqual([
      first,
      'structured-agent-session-chat-1',
      results[1]!.tabId!
    ])
  })

  it('opens into the new split group the window made for it', () => {
    const ctx = testContext()
    const { model } = build(ctx, [{ type: 'createTerminalTab', workspace: WS }])
    const besideGroupId = model.workspaces[WS]!.groups[0]!.id
    const split = build(
      ctx,
      [drawn({ groupId: 'g2', split: { besideGroupId, direction: 'right' } })],
      model
    ).model
    expect(split.workspaces[WS]?.groups.map((group) => group.id)).toEqual([besideGroupId, 'g2'])
    expect(split.workspaces[WS]?.groupLayout).toMatchObject({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: besideGroupId },
      second: { type: 'leaf', groupId: 'g2' }
    })
  })

  it('mints its own group still when the open names none', () => {
    const { model } = build(testContext(), [drawn({ tabId: undefined })], emptyModel())
    expect(model.workspaces[WS]?.groups).toHaveLength(1)
  })

  it('with the switch off, still takes a taken id as shipped builds do (legacy duplicate)', () => {
    switchState.layoutOwnerIsMain = false
    const ctx = testContext()
    const { model } = build(ctx, [drawn()])
    const again = applyLayoutCommand(model, drawn({ sessionId: 'chat-2' }), ctx)
    expect(again.ok && again.model.workspaces[WS]?.tabs.map((tab) => tab.entityId)).toEqual([
      'chat-1',
      'chat-2'
    ])
  })
})
