// Switch-off builds (the switch reads off in tests): a workspace's first group keeps a minted id.

import { describe, expect, it, vi } from 'vitest'
import { build, testContext, WS } from './workspace-layout-command.test-fixture'

// rollback build (switch-off) — delete with the switch-off code post-flip
vi.mock('../layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))

describe('a workspace first group with the layout-owner switch off', () => {
  it('is a minted id, whatever group the sender names', () => {
    const plain = build(testContext(), [{ type: 'createTerminalTab', workspace: WS }])
    const named = build(testContext(), [
      { type: 'createTerminalTab', workspace: WS, groupId: 'window-group' }
    ])
    const browser = build(testContext(), [
      { type: 'openBrowserTab', workspace: WS, groupId: 'window-group' }
    ])

    for (const { model } of [plain, named, browser]) {
      expect(model.workspaces[WS]!.groups.map((group) => group.id)).toEqual([
        expect.stringMatching(/^id-\d+$/)
      ])
    }
  })
})
