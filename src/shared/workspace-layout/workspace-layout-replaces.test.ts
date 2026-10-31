import { describe, expect, it } from 'vitest'
import { applyLayoutCommand } from './workspace-layout-commands'
import { build, testContext, WS } from './workspace-layout-command.test-fixture'

describe('replaces: one write puts the new tab in the replaced tab’s slot', () => {
  it('a terminal takes a chat tab’s index and the chat tab closes', () => {
    const ctx = testContext()
    const { model, results } = build(ctx, [
      { type: 'createTerminalTab', workspace: WS },
      {
        type: 'openAgentSessionTab',
        workspace: WS,
        tabId: 'chat-tab',
        sessionId: 's1',
        agent: 'codex'
      },
      { type: 'createTerminalTab', workspace: WS }
    ])
    const replaced = applyLayoutCommand(
      model,
      {
        type: 'createTerminalTab',
        workspace: WS,
        adopt: { ptyId: 'pty-1' },
        replaces: { tabId: 'chat-tab' }
      },
      ctx
    )
    expect(replaced.ok).toBe(true)
    if (!replaced.ok) {
      return
    }
    expect(replaced.result.closed).toEqual(['chat-tab'])
    expect(replaced.model.workspaces[WS]?.groups[0]?.tabOrder).toEqual([
      results[0]!.tabId,
      replaced.result.tabId,
      results[2]!.tabId
    ])
    expect(replaced.model.workspaces[WS]?.tabs.some((tab) => tab.id === 'chat-tab')).toBe(false)
    expect(replaced.effects.startPaneKeys).toEqual([])
  })

  it('a chat takes a terminal tab’s index, keeping a one-tab group alive', () => {
    const ctx = testContext()
    const { model, results } = build(ctx, [{ type: 'createTerminalTab', workspace: WS }])
    const terminal = results[0]!.tabId!
    const replaced = applyLayoutCommand(
      model,
      {
        type: 'openAgentSessionTab',
        workspace: WS,
        tabId: 'chat-tab',
        sessionId: 's1',
        agent: 'codex',
        replaces: { tabId: terminal }
      },
      ctx
    )
    expect(replaced.ok && replaced.result.closed).toEqual([terminal])
    expect(replaced.ok && replaced.model.workspaces[WS]?.groups).toEqual([
      { id: model.workspaces[WS]!.groups[0]!.id, tabOrder: ['chat-tab'] }
    ])
  })

  it('degrades to an ordinary open when the replaced tab is already gone', () => {
    const ctx = testContext()
    const { model, results } = build(ctx, [{ type: 'createTerminalTab', workspace: WS }])
    const opened = applyLayoutCommand(
      model,
      {
        type: 'openAgentSessionTab',
        workspace: WS,
        tabId: 'chat-tab',
        sessionId: 's1',
        agent: 'codex',
        replaces: { tabId: 'gone' }
      },
      ctx
    )
    expect(opened.ok && opened.result.closed).toBeUndefined()
    expect(opened.ok && opened.model.workspaces[WS]?.groups[0]?.tabOrder).toEqual([
      results[0]!.tabId,
      'chat-tab'
    ])
  })
})
