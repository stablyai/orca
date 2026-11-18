import { describe, expect, it } from 'vitest'
import { TAB_CONTENT_TRAITS, toVisibleTabType } from './tab-groups/tab-types'
import { applyLayoutCommand } from './workspace-layout-commands'
import type { CommandOf } from './workspace-layout-command-types'
import { build, testContext, WS } from './commands/workspace-layout-command.test-fixture'

const room = (fields: Partial<CommandOf<'openRoomTab'>> = {}): CommandOf<'openRoomTab'> => ({
  type: 'openRoomTab',
  workspace: WS,
  tabId: 'room-1',
  botGroupId: 'group-a',
  ...fields
})

describe('a room tab', () => {
  it('holds the bot group as its entity under the window’s id', () => {
    const { model, results } = build(testContext(), [room({ groupId: 'g1', createdAt: 7 })])
    expect(results[0]?.tabId).toBe('room-1')
    expect(model.workspaces[WS]?.tabs).toEqual([
      {
        id: 'room-1',
        entityId: 'group-a',
        kind: 'room',
        createdAt: 7,
        customTitle: null,
        color: null
      }
    ])
  })

  it('changes nothing when sent again, and refuses an id another tab holds', () => {
    const ctx = testContext()
    const { model, results } = build(ctx, [{ type: 'createTerminalTab', workspace: WS }, room()])
    const again = applyLayoutCommand(model, room(), ctx)
    expect(again.ok && again.model).toEqual(model)
    const taken = applyLayoutCommand(model, room({ tabId: results[0]!.tabId! }), ctx)
    expect(taken.ok ? 'applied' : taken.code).toBe('tab_exists')
  })

  it('renders without a backing record and shows where a chat does', () => {
    expect(TAB_CONTENT_TRAITS.room.renderableWithoutRecord).toBe(true)
    expect(toVisibleTabType('room')).toBe('agent-session')
  })
})
