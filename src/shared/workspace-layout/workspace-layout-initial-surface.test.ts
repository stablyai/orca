import { describe, expect, it } from 'vitest'
import { applyLayoutCommand } from './workspace-layout-commands'
import type { InitialSurfaceReason, LayoutCommand } from './workspace-layout-command-types'
import { build, emptyModel, testContext, WS } from './workspace-layout-command.test-fixture'
import type { WorkspaceLayoutModel } from './workspace-layout-model'

const REASONS: InitialSurfaceReason[] = ['restore', 'activation']

function initialSurfaces(model: WorkspaceLayoutModel, initial: InitialSurfaceReason) {
  const commands: LayoutCommand[] = [
    { type: 'createTerminalTab', workspace: WS, initial },
    { type: 'openAgentSessionTab', workspace: WS, sessionId: 's-1', agent: 'claude', initial }
  ]
  return commands.map((command) => {
    const result = applyLayoutCommand(model, command, testContext())
    if (!result.ok) {
      throw new Error(result.code)
    }
    return result.model.workspaces[WS]?.tabs.length ?? 0
  })
}

describe('initial surface', () => {
  it('is created into a workspace with no entry, for either reason', () => {
    for (const reason of REASONS) {
      expect(initialSurfaces(emptyModel(), reason)).toEqual([1, 1])
    }
  })

  it('is created into an empty published entry that never held a terminal row', () => {
    const published: WorkspaceLayoutModel = {
      ...emptyModel(),
      workspaces: { [WS]: { worktreeId: WS, tabs: [], groups: [] } }
    }
    for (const reason of REASONS) {
      expect(initialSurfaces(published, reason)).toEqual([1, 1])
    }
  })

  it('is not restored into a workspace a close emptied, but a user opening it gets one', () => {
    const context = testContext()
    const created = build(context, [{ type: 'createTerminalTab', workspace: WS }])
    const emptied = build(
      context,
      [{ type: 'closeTabs', workspace: WS, tabIds: [created.results[0]!.tabId!] }],
      created.model
    ).model
    expect(emptied.legacy.terminalRowOwners[WS]).toBe(true)
    expect(initialSurfaces(emptied, 'restore')).toEqual([0, 0])
    expect(initialSurfaces(emptied, 'activation')).toEqual([1, 1])
  })

  it('is a no-op once the workspace has any tab, so two senders make one surface', () => {
    const context = testContext()
    const withEditor = build(context, [
      { type: 'openEditorTab', workspace: WS, fileId: '/repo/a.ts', contentType: 'editor' }
    ]).model
    for (const reason of REASONS) {
      expect(initialSurfaces(withEditor, reason)).toEqual([1, 1])
    }
    const once = build(context, [
      { type: 'createTerminalTab', workspace: WS, initial: 'activation' },
      { type: 'createTerminalTab', workspace: WS, initial: 'restore' },
      {
        type: 'openAgentSessionTab',
        workspace: WS,
        sessionId: 's',
        agent: 'claude',
        initial: 'activation'
      }
    ])
    expect(once.model.workspaces[WS]!.tabs.map((tab) => tab.kind)).toEqual(['terminal'])
    expect(once.results.slice(1)).toEqual([{}, {}])
  })
})
