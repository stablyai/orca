// A layout-owner build's first group of a workspace: main names it as the window and the Loader
// do, so a window save before main's frame keeps main's group.

import { describe, expect, it, vi } from 'vitest'
import { build, testContext, WS } from './workspace-layout-command.test-fixture'
import { workspaceRootGroupId } from './workspace-layout-minted-ids'

vi.mock('../layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const groupIds = (model: ReturnType<typeof build>['model']) =>
  model.workspaces[WS]!.groups.map((group) => group.id)

describe('a workspace first group in a layout-owner build', () => {
  it('is the workspace root group id when the sender names none', () => {
    const { model } = build(testContext(), [
      { type: 'createTerminalTab', workspace: WS, initial: 'activation' }
    ])

    expect(groupIds(model)).toEqual([workspaceRootGroupId(WS)])
  })

  it('is the group the sender drew the tab in, for terminal and content tabs', () => {
    const terminal = build(testContext(), [
      { type: 'createTerminalTab', workspace: WS, groupId: 'window-group' }
    ])
    const browser = build(testContext(), [
      { type: 'openBrowserTab', workspace: WS, groupId: 'window-group' }
    ])

    expect(groupIds(terminal.model)).toEqual(['window-group'])
    expect(groupIds(browser.model)).toEqual(['window-group'])
  })

  it('keeps an existing group over the one the sender names', () => {
    const ctx = testContext()
    const first = build(ctx, [{ type: 'createTerminalTab', workspace: WS }])
    const second = build(
      ctx,
      [{ type: 'createTerminalTab', workspace: WS, groupId: 'window-group' }],
      first.model
    )

    expect(groupIds(second.model)).toEqual([workspaceRootGroupId(WS)])
  })
})
