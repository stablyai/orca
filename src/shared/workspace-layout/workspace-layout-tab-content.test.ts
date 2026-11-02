import { describe, expect, it } from 'vitest'
import { applyLayoutCommand } from './workspace-layout-commands'
import { build, testContext, WS } from './workspace-layout-command.test-fixture'
import type { CommandOf } from './workspace-layout-command-types'
import type { WorkspaceLayoutModel } from './workspace-layout-model'

const LEAF = '11111111-1111-4111-8111-111111111111'

/** A pinned terminal tab between two others: the tab a switch changes. */
function setup() {
  const ctx = testContext()
  const { model, results } = build(ctx, [
    { type: 'createTerminalTab', workspace: WS },
    { type: 'createTerminalTab', workspace: WS, color: 'red' },
    { type: 'createTerminalTab', workspace: WS }
  ])
  const [left, switched, right] = results.map((result) => result!.tabId!)
  const pinned = build(
    ctx,
    [
      { type: 'setTabProps', workspace: WS, tabId: switched!, isPinned: true },
      { type: 'renameTab', workspace: WS, tabId: switched!, kind: 'custom', title: 'my cli' }
    ],
    model
  )
  return { ctx, model: pinned.model, left: left!, switched: switched!, right: right! }
}

const toChat = (tabId: string, terminalId: string): CommandOf<'setTabContent'> => ({
  type: 'setTabContent',
  workspace: WS,
  tabId,
  expectSource: { kind: 'terminal', terminalId },
  content: { kind: 'agent-session', sessionId: 'session-1', agent: 'codex' }
})

const toTerminal = (tabId: string, terminalId: string): CommandOf<'setTabContent'> => ({
  type: 'setTabContent',
  workspace: WS,
  tabId,
  expectSource: { kind: 'agent-session', sessionId: 'session-1' },
  content: { kind: 'terminal', terminalId, leafId: LEAF, adopt: { ptyId: 'pty-2' } }
})

const tabOf = (model: WorkspaceLayoutModel, tabId: string) =>
  model.workspaces[WS]!.tabs.find((tab) => tab.id === tabId)

describe('setTabContent: a switch changes what a tab holds, never the tab', () => {
  it('keeps the tab’s id, place, pin and color through a round trip; the old terminal stays closed', () => {
    const { ctx, model, switched } = setup()
    const order = model.workspaces[WS]!.groups[0]!.tabOrder
    const chat = build(ctx, [toChat(switched, switched)], model)
    expect(chat.results[0]).toEqual({ tabId: switched, retargeted: true })
    expect(tabOf(chat.model, switched)).toMatchObject({
      kind: 'agent-session',
      entityId: 'session-1',
      isPinned: true,
      color: 'red',
      customTitle: null
    })
    expect(chat.model.workspaces[WS]!.closedTerminalTabs?.[switched]?.reason).toBe('cleanup')
    const back = build(ctx, [toTerminal(switched, 'terminal-2')], chat.model)
    expect(back.results[0]).toEqual({ tabId: switched, retargeted: true })
    const tab = tabOf(back.model, switched)
    expect(tab).toMatchObject({ kind: 'terminal', entityId: 'terminal-2', isPinned: true })
    expect(back.model.workspaces[WS]!.leaves?.[LEAF]).toEqual({ ptyId: 'pty-2' })
    expect(back.model.workspaces[WS]!.groups[0]!.tabOrder).toEqual(order)
  })

  it('a retry after a lost answer finds its destination already there', () => {
    const { ctx, model, switched } = setup()
    const chat = build(ctx, [toChat(switched, switched)], model)
    const retried = applyLayoutCommand(chat.model, toChat(switched, switched), ctx)
    expect(retried.ok && retried.result).toEqual({ tabId: switched, retargeted: true })
    expect(retried.ok && retried.model).toEqual(chat.model)
  })

  it.each([
    [
      'closed',
      (model: WorkspaceLayoutModel, ctx: ReturnType<typeof testContext>, tabId: string) =>
        build(ctx, [{ type: 'closeTabs', workspace: WS, tabIds: [tabId], force: true }], model)
          .model
    ],
    [
      'split',
      (model: WorkspaceLayoutModel, ctx: ReturnType<typeof testContext>, tabId: string) => {
        const leafId = model.workspaces[WS]!.tabs.find((tab) => tab.id === tabId)!
        const root = leafId.kind === 'terminal' && leafId.panes.root
        return build(
          ctx,
          [
            {
              type: 'splitPane',
              workspace: WS,
              tabId,
              leafId: root && root.type === 'leaf' ? root.leafId : '',
              direction: 'vertical'
            }
          ],
          model
        ).model
      }
    ]
  ] as const)('changes nothing once the user %s the source during the switch', (_name, edit) => {
    const { ctx, model, switched } = setup()
    const edited = edit(model, ctx, switched)
    const applied = applyLayoutCommand(edited, toChat(switched, switched), ctx)
    expect(applied.ok && applied.result.retargeted).toBe(false)
    expect(applied.ok && applied.model).toEqual(edited)
  })

  it('takes in a pane main already holds for the switch’s parked terminal', () => {
    const { ctx, model, switched } = setup()
    const chat = build(ctx, [toChat(switched, switched)], model)
    const parked = build(
      ctx,
      [
        {
          type: 'createTerminalTab',
          workspace: WS,
          tabId: 'terminal-2',
          leafId: LEAF,
          adopt: { ptyId: 'pty-2' }
        }
      ],
      chat.model
    )
    const back = build(ctx, [toTerminal(switched, 'terminal-2')], parked.model)
    const workspace = back.model.workspaces[WS]!
    expect(
      workspace.tabs.filter((tab) => tab.entityId === 'terminal-2').map((tab) => tab.id)
    ).toEqual([switched])
    expect(workspace.groups.flatMap((group) => group.tabOrder)).not.toContain('terminal-2')
    expect(workspace.leaves?.[LEAF]?.ptyId).toBe('pty-2')
  })
})
