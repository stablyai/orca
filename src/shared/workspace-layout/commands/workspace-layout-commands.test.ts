import { describe, expect, it } from 'vitest'

import { applyLayoutCommand } from '../workspace-layout-commands'
import type { CommandOf, LayoutCommand } from '../workspace-layout-command-types'
import { build, terminalTab, testContext, WS } from './workspace-layout-command.test-fixture'
import type { WorkspaceLayoutModel } from '../workspace-layout-model'
import '../persistence/workspace-layout-save'

const context = testContext()

/** Two terminal tabs (the first split in two) and an editor tab, in one group. */
function setup() {
  const ctx = testContext()
  const { model, results } = build(ctx, [
    { type: 'createTerminalTab', workspace: WS },
    { type: 'createTerminalTab', workspace: WS },
    {
      type: 'openEditorTab',
      workspace: WS,
      fileId: '/w/a.ts',
      contentType: 'editor',
      file: { filePath: '/w/a.ts', relativePath: 'a.ts', language: 'typescript' }
    }
  ])
  const [first, second, editor] = results
  const split = build(
    ctx,
    [
      {
        type: 'splitPane',
        workspace: WS,
        tabId: first!.tabId!,
        leafId: first!.leafId!,
        direction: 'vertical'
      }
    ],
    model
  )
  return {
    ctx,
    model: split.model,
    tabA: first!.tabId!,
    leafA: first!.leafId!,
    leafA2: split.results[0]!.leafId!,
    tabB: second!.tabId!,
    leafB: second!.leafId!,
    editor: editor!.tabId!
  }
}

function refusal(model: WorkspaceLayoutModel, command: LayoutCommand) {
  const result = applyLayoutCommand(model, command, context)
  return result.ok ? 'applied' : result.code
}

const groupOrder = (model: WorkspaceLayoutModel) =>
  model.workspaces[WS]!.groups.map((group) => group.tabOrder)

describe('layout command refusals', () => {
  it('movePaneToNewTab opens the chat pane’s new tab in chat view, as the window does', () => {
    const { ctx, model, tabA, leafA, leafA2 } = setup()
    const chat = build(
      ctx,
      [{ type: 'setChatPane', workspace: WS, tabId: tabA, leafId: leafA2 }],
      model
    ).model
    const moveOut = (leafId: string) =>
      build(ctx, [{ type: 'movePaneToNewTab', workspace: WS, tabId: tabA, leafId }], chat)
    const chatMove = moveOut(leafA2)
    const chatTab = chatMove.model.workspaces[WS]!.tabs.find(
      (tab) => tab.id === chatMove.results[0]!.tabId
    )
    expect(chatTab).toMatchObject({ viewMode: 'chat', panes: { chatLeafId: leafA2 } })
    const shellMove = moveOut(leafA)
    const shellTab = shellMove.model.workspaces[WS]!.tabs.find(
      (tab) => tab.id === shellMove.results[0]!.tabId
    )
    expect(shellTab).not.toHaveProperty('viewMode')
  })

  it('startPane refuses a missing pane and starts a slept one from its record; restartPane refuses a missing one', () => {
    const { model, tabB, leafB } = setup()
    const paneKey = `${tabB}:${leafB}`
    expect(refusal(model, { type: 'startPane', workspace: WS, paneKey: 'nope:x' })).toBe(
      'pane_not_found'
    )
    expect(refusal(model, { type: 'restartPane', workspace: WS, paneKey: 'nope:x' })).toBe(
      'pane_not_found'
    )
    const record = {
      paneKey,
      tabId: tabB,
      worktreeId: WS,
      agent: 'codex' as const,
      providerSession: { key: 'session_id' as const, id: 's' },
      prompt: 'p',
      state: 'done' as const,
      capturedAt: 1,
      updatedAt: 1
    }
    const slept = build(
      testContext(),
      [{ type: 'sleep', workspace: WS, records: [record] }],
      model
    ).model
    // The runtime's start resumes the agent the record names, so a slept pane starts from it.
    expect(
      applyLayoutCommand(slept, { type: 'startPane', workspace: WS, paneKey }, context)
    ).toMatchObject({ ok: true, effects: { startPaneKeys: [paneKey] } })
    // A wake starts the pane and keeps its record; a record-only wake drops it.
    const woken = applyLayoutCommand(slept, { type: 'wake', workspace: WS }, context)
    expect(woken).toMatchObject({
      ok: true,
      result: { woken: [paneKey] },
      effects: { startPaneKeys: [paneKey] }
    })
    expect(woken.ok && woken.model).toEqual(slept)
    const dropped = build(testContext(), [{ type: 'wake', workspace: WS, recordOnly: true }], slept)
    expect(dropped.results[0]!.woken).toEqual([paneKey])
    expect(dropped.model.workspaces[WS]!.leaves?.[leafB]?.sleeping).toBeUndefined()
  })

  it('startPane leaves a live pane with a resume record alone, and starts one restoring from its record', () => {
    const { model, tabB, leafB } = setup()
    const paneKey = `${tabB}:${leafB}`
    const sleeping = {
      agent: 'codex' as const,
      providerSession: { key: 'session_id' as const, id: 's' },
      prompt: 'p',
      state: 'working' as const,
      capturedAt: 1,
      updatedAt: 1,
      origin: 'live' as const
    }
    const withLeaf = (leaf: { ptyId?: string }): WorkspaceLayoutModel => {
      const workspace = model.workspaces[WS]!
      return {
        ...model,
        workspaces: {
          ...model.workspaces,
          [WS]: { ...workspace, leaves: { ...workspace.leaves, [leafB]: { ...leaf, sleeping } } }
        }
      }
    }
    const start = { type: 'startPane', workspace: WS, paneKey } as const
    expect(applyLayoutCommand(withLeaf({ ptyId: 'pty-b' }), start, context)).toMatchObject({
      ok: true,
      effects: { startPaneKeys: [] }
    })
    // Its terminal is gone, or a start status says its binding is what it restores from.
    expect(applyLayoutCommand(withLeaf({}), start, context)).toMatchObject({
      ok: true,
      effects: { startPaneKeys: [paneKey] }
    })
    expect(
      applyLayoutCommand(withLeaf({ ptyId: 'pty-b' }), start, {
        ...context,
        isBindingLive: (key) => key !== paneKey
      })
    ).toMatchObject({ ok: true, effects: { startPaneKeys: [paneKey] } })
  })

  it('startPane replaces an empty shell a hibernated agent left, as a restart does', () => {
    const { model, tabB, leafB } = setup()
    const paneKey = `${tabB}:${leafB}`
    const workspace = model.workspaces[WS]!
    const bound: WorkspaceLayoutModel = {
      ...model,
      workspaces: {
        ...model.workspaces,
        [WS]: { ...workspace, leaves: { ...workspace.leaves, [leafB]: { ptyId: 'pty-b' } } }
      }
    }
    const start = { type: 'startPane', workspace: WS, paneKey } as const

    const applied = applyLayoutCommand(bound, start, {
      ...context,
      retiresBinding: (key, ptyId) => key === paneKey && ptyId === 'pty-b'
    })

    expect(applied).toMatchObject({
      ok: true,
      effects: { stopPtyIds: ['pty-b'], startPaneKeys: [paneKey] }
    })
    expect(applied.ok && applied.model.workspaces[WS]!.leaves?.[leafB]?.ptyId).toBeUndefined()
  })

  it('a record-only sleep and wake change the resume record and stop or start nothing', () => {
    const { model, tabB, leafB } = setup()
    const paneKey = `${tabB}:${leafB}`
    const workspace = model.workspaces[WS]!
    const bound: WorkspaceLayoutModel = {
      ...model,
      workspaces: {
        ...model.workspaces,
        [WS]: { ...workspace, leaves: { ...workspace.leaves, [leafB]: { ptyId: 'pty-b' } } }
      }
    }
    const record = {
      paneKey,
      tabId: tabB,
      worktreeId: WS,
      agent: 'codex' as const,
      providerSession: { key: 'session_id' as const, id: 's' },
      prompt: 'p',
      state: 'working' as const,
      capturedAt: 1,
      updatedAt: 1,
      origin: 'live' as const
    }
    const sleep: CommandOf<'sleep'> = {
      type: 'sleep',
      workspace: WS,
      paneKeys: [paneKey],
      records: [record]
    }
    expect(applyLayoutCommand(bound, sleep, context)).toMatchObject({
      effects: { stopPtyIds: ['pty-b'] }
    })

    const recorded = applyLayoutCommand(bound, { ...sleep, recordOnly: true }, context)
    expect(recorded).toMatchObject({ ok: true, effects: { stopPtyIds: [] } })
    const recordedModel = recorded.ok ? recorded.model : bound
    // A running agent's capture is its resume record, not a sleep.
    expect(recordedModel.workspaces[WS]!.leaves![leafB]).toEqual({
      ptyId: 'pty-b',
      resume: {
        agent: 'codex',
        providerSession: { key: 'session_id', id: 's' },
        prompt: 'p',
        state: 'working',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'live'
      }
    })
    const cleared = applyLayoutCommand(
      recordedModel,
      { type: 'wake', workspace: WS, paneKeys: [paneKey], recordOnly: true },
      context
    )
    expect(cleared).toMatchObject({
      ok: true,
      result: { woken: [paneKey] },
      effects: { startPaneKeys: [] }
    })
    expect(cleared.ok && cleared.model.workspaces[WS]!.leaves![leafB]).toEqual({ ptyId: 'pty-b' })
  })
})

describe('closeTabs', () => {
  it('refuses a pinned tab only for senders that confirm pinned closes, and never with force', () => {
    const { model, tabB, ctx } = setup()
    const pinned = build(
      ctx,
      [{ type: 'setTabProps', workspace: WS, tabId: tabB, isPinned: true }],
      model
    ).model
    const asPhone = applyLayoutCommand(
      pinned,
      { type: 'closeTabs', workspace: WS, tabIds: [tabB], refusePinned: true },
      ctx
    )
    expect(asPhone).toMatchObject({
      ok: true,
      result: { closed: [], refused: [{ tabId: tabB, code: 'tab_pinned' }] }
    })
    const forced = applyLayoutCommand(
      pinned,
      { type: 'closeTabs', workspace: WS, tabIds: [tabB], refusePinned: true, force: true },
      ctx
    )
    expect(forced).toMatchObject({ ok: true, result: { closed: [tabB] } })
    const asWindow = applyLayoutCommand(
      pinned,
      { type: 'closeTabs', workspace: WS, tabIds: [tabB] },
      ctx
    )
    expect(asWindow).toMatchObject({ ok: true, result: { closed: [tabB] } })
  })

  it('refuses an editor tab with an unsaved draft unless forced, and closes the rest in one apply', () => {
    const { model, editor, tabA, ctx } = setup()
    const result = applyLayoutCommand(
      model,
      { type: 'closeTabs', workspace: WS, tabIds: [editor, tabA, 'gone'], dirtyTabIds: [editor] },
      ctx
    )
    expect(result).toMatchObject({
      ok: true,
      result: {
        closed: [tabA, 'gone'],
        refused: [{ tabId: editor, code: 'editor_tab_has_unsaved_draft' }]
      }
    })
    if (result.ok) {
      expect(result.effects.stopPtyIds).toEqual([])
      expect(groupOrder(result.model)).toEqual([[expect.any(String), editor]])
    }
  })
})

describe('layout command effects', () => {
  it('a window drag-out names the tab, outranks a stale binding and moves a last pane', () => {
    const { model, tabA, tabB, leafA2, leafB, ctx } = setup()
    const workspace = model.workspaces[WS]!
    const withData: WorkspaceLayoutModel = {
      ...model,
      workspaces: {
        [WS]: {
          ...workspace,
          leaves: { ...workspace.leaves, [leafA2]: { ptyId: 'pty-old', incarnationId: 'inc' } }
        }
      }
    }
    const stale = build(
      ctx,
      [
        {
          type: 'movePaneToNewTab',
          workspace: WS,
          tabId: tabA,
          leafId: leafA2,
          windowDetach: { ptyId: 'pty-live', tabId: 'tab-main' }
        }
      ],
      withData
    )
    expect(stale.results[0]).toEqual({ tabId: 'tab-main', ptyId: 'pty-live' })
    expect(stale.model.workspaces[WS]!.leaves?.[leafA2]).toEqual({ ptyId: 'pty-live' })
    // A copy that never bound the pane keeps its incarnation, as the desktop's move does.
    const unbound = applyLayoutCommand(
      {
        ...model,
        workspaces: {
          [WS]: {
            ...workspace,
            leaves: { ...workspace.leaves, [leafA2]: { incarnationId: 'inc' } }
          }
        }
      },
      {
        type: 'movePaneToNewTab',
        workspace: WS,
        tabId: tabA,
        leafId: leafA2,
        windowDetach: { ptyId: 'pty-live', tabId: 'tab-main' }
      },
      ctx
    )
    expect(unbound.ok && unbound.model.workspaces[WS]!.leaves?.[leafA2]).toEqual({
      ptyId: 'pty-live',
      incarnationId: 'inc'
    })

    // Main lacks the window’s sibling panes, so retain their tab; main alone sees only a re-ID and cannot run the structural check.
    const last = applyLayoutCommand(
      model,
      {
        type: 'movePaneToNewTab',
        workspace: WS,
        tabId: tabB,
        leafId: leafB,
        windowDetach: { ptyId: null }
      },
      ctx
    )
    if (!last.ok) {
      throw new Error(last.code)
    }
    const newTabId = last.result.tabId!
    expect(terminalTab(last.model, newTabId).panes.root).toEqual({ type: 'leaf', leafId: leafB })
    expect(terminalTab(last.model, tabB).panes.root).toBeNull()
    expect(last.result.ptyId).toBeNull()
  })

  it('a window drag-out starts an unbound pane’s new tab in the pane’s folder', () => {
    const { model, tabA, leafA2, ctx } = setup()
    const workspace = model.workspaces[WS]!
    const withCwd: WorkspaceLayoutModel = {
      ...model,
      workspaces: {
        [WS]: {
          ...workspace,
          tabs: workspace.tabs.map((tab) =>
            tab.id === tabA && tab.kind === 'terminal'
              ? { ...tab, terminal: { ...tab.terminal, startupCwd: '/w' } }
              : tab
          )
        }
      }
    }
    const drag = (ptyId: string | null) =>
      build(
        ctx,
        [
          {
            type: 'movePaneToNewTab',
            workspace: WS,
            tabId: tabA,
            leafId: leafA2,
            windowDetach: { ptyId, tabId: 'tab-main', startupCwd: '/w/packages/app' }
          }
        ],
        withCwd
      ).model
    expect(terminalTab(drag(null), 'tab-main').terminal.startupCwd).toBe('/w/packages/app')
    // A bound pane keeps its shell; its new tab keeps the source tab's folder.
    expect(terminalTab(drag('pty-live'), 'tab-main').terminal.startupCwd).toBe('/w')
  })

  it('reuses the open tab for a file and replaces a preview tab of the same kind', () => {
    const { model, editor, ctx } = setup()
    const again = applyLayoutCommand(
      model,
      { type: 'openEditorTab', workspace: WS, fileId: '/w/a.ts', contentType: 'editor' },
      ctx
    )
    expect(again).toMatchObject({ ok: true, result: { tabId: editor } })
    const previews = build(
      ctx,
      [
        {
          type: 'openEditorTab',
          workspace: WS,
          fileId: '/w/b.ts',
          contentType: 'editor',
          preview: true
        },
        {
          type: 'openEditorTab',
          workspace: WS,
          fileId: '/w/c.ts',
          contentType: 'editor',
          preview: true
        }
      ],
      model
    )
    const entities = previews.model.workspaces[WS]!.tabs.map((tab) => tab.entityId)
    expect(entities).toContain('/w/c.ts')
    expect(entities).not.toContain('/w/b.ts')
  })
})
