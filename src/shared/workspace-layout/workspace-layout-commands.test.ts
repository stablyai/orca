import { describe, expect, it } from 'vitest'
import type { EditorTabView } from '../editor-tab-view-types'
import { applyLayoutCommand } from './workspace-layout-commands'
import type { CommandOf, LayoutCommand } from './workspace-layout-command-types'
import {
  asLoaded,
  build,
  emptyModel,
  terminalTab,
  testContext,
  WS
} from './workspace-layout-command.test-fixture'
import type { WorkspaceLayoutModel } from './workspace-layout-model'
import { saveWorkspaceLayout } from './workspace-layout-save'

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
  it('refuses commands on a workspace the model has never seen, and treats closes there as done', () => {
    const model = emptyModel()
    expect(
      refusal(model, {
        type: 'splitPane',
        workspace: WS,
        tabId: 't',
        leafId: 'l',
        direction: 'vertical'
      })
    ).toBe('workspace_not_found')
    expect(
      applyLayoutCommand(model, { type: 'closeTabs', workspace: WS, tabIds: ['t'] }, context)
    ).toMatchObject({ ok: true, result: { alreadyClosed: true } })
    expect(
      applyLayoutCommand(
        model,
        { type: 'closePane', workspace: WS, tabId: 't', leafId: 'l' },
        context
      )
    ).toMatchObject({ ok: true, result: { alreadyClosed: true } })
  })

  it('pane commands refuse a missing tab or pane', () => {
    const { model, tabA, leafA } = setup()
    expect(
      refusal(model, {
        type: 'splitPane',
        workspace: WS,
        tabId: 'nope',
        leafId: leafA,
        direction: 'vertical'
      })
    ).toBe('tab_not_found')
    expect(
      refusal(model, {
        type: 'splitPane',
        workspace: WS,
        tabId: tabA,
        leafId: 'nope',
        direction: 'vertical'
      })
    ).toBe('pane_not_found')
    expect(
      refusal(model, { type: 'renamePane', workspace: WS, tabId: tabA, leafId: 'nope', title: 'x' })
    ).toBe('pane_not_found')
    expect(
      refusal(model, { type: 'setChatPane', workspace: WS, tabId: tabA, leafId: 'nope' })
    ).toBe('pane_not_found')
    expect(
      refusal(model, {
        type: 'movePane',
        workspace: WS,
        tabId: tabA,
        leafId: leafA,
        targetLeafId: 'nope',
        side: 'left'
      })
    ).toBe('pane_not_found')
    expect(refusal(model, { type: 'equalizePanes', workspace: WS, tabId: 'nope' })).toBe(
      'tab_not_found'
    )
    expect(
      refusal(model, {
        type: 'renameTab',
        workspace: WS,
        tabId: 'nope',
        kind: 'custom',
        title: 'x'
      })
    ).toBe('tab_not_found')
    expect(
      refusal(model, { type: 'setTabProps', workspace: WS, tabId: 'nope', color: 'red' })
    ).toBe('tab_not_found')
    expect(refusal(model, { type: 'promotePreviewTab', workspace: WS, tabId: 'nope' })).toBe(
      'tab_not_found'
    )
  })

  it('movePane refuses moving a pane onto itself', () => {
    const { model, tabA, leafA } = setup()
    expect(
      refusal(model, {
        type: 'movePane',
        workspace: WS,
        tabId: tabA,
        leafId: leafA,
        targetLeafId: leafA,
        side: 'left'
      })
    ).toBe('same_pane')
  })

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

  it('movePaneToNewTab refuses the last pane, which moves as a tab instead', () => {
    const { model, tabB, leafB } = setup()
    expect(
      refusal(model, { type: 'movePaneToNewTab', workspace: WS, tabId: tabB, leafId: leafB })
    ).toBe('last_pane')
  })

  it('group commands refuse a missing group, a changed group set, and splitting a lone tab off itself', () => {
    const { model, tabA } = setup()
    const groupId = model.workspaces[WS]!.groups[0]!.id
    expect(
      refusal(model, { type: 'moveTab', workspace: WS, tabId: tabA, toGroupId: 'nope', index: 0 })
    ).toBe('group_not_found')
    expect(
      refusal(model, {
        type: 'moveTab',
        workspace: WS,
        tabId: 'nope',
        toGroupId: groupId,
        index: 0
      })
    ).toBe('tab_not_found')
    expect(
      refusal(model, {
        type: 'splitGroup',
        workspace: WS,
        tabId: tabA,
        besideGroupId: 'nope',
        direction: 'right'
      })
    ).toBe('group_not_found')
    expect(
      refusal(model, {
        type: 'setGroupRatios',
        workspace: WS,
        groupLayout: { type: 'leaf', groupId: 'other' }
      })
    ).toBe('group_set_changed')
    expect(
      refusal(model, {
        type: 'setGroupRatios',
        workspace: WS,
        groupLayout: { type: 'leaf', groupId }
      })
    ).toBe('applied')
    const single = build(testContext(), [{ type: 'createTerminalTab', workspace: WS }]).model
    expect(
      refusal(single, {
        type: 'splitGroup',
        workspace: WS,
        tabId: single.workspaces[WS]!.tabs[0]!.id,
        besideGroupId: single.workspaces[WS]!.groups[0]!.id,
        direction: 'right'
      })
    ).toBe('invalid_params')
  })

  it('startPane refuses a missing or sleeping pane; restartPane a missing one', () => {
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
    expect(refusal(slept, { type: 'startPane', workspace: WS, paneKey })).toBe('pane_sleeping')
    const woken = build(testContext(), [{ type: 'wake', workspace: WS }], slept)
    expect(woken.results[0]!.woken).toEqual([paneKey])
    expect(refusal(woken.model, { type: 'startPane', workspace: WS, paneKey })).toBe('applied')
  })

  it('startPane leaves a bound pane with a live resume record alone, and refuses an unbound one', () => {
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
    // Its terminal is gone: a plain start would lose how the agent resumes.
    expect(refusal(withLeaf({}), start)).toBe('pane_sleeping')
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
    expect(recordedModel.workspaces[WS]!.leaves![leafB]).toEqual({
      ptyId: 'pty-b',
      sleeping: {
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
  it('places a new terminal after its anchor, keeps pinned tabs first, and reuses the lowest free ordinal', () => {
    const { model, tabA, tabB, editor, ctx } = setup()
    const pinned = build(
      ctx,
      [{ type: 'setTabProps', workspace: WS, tabId: editor, isPinned: true }],
      model
    ).model
    expect(groupOrder(pinned)).toEqual([[editor, tabA, tabB]])
    const closed = build(ctx, [{ type: 'closeTabs', workspace: WS, tabIds: [tabA] }], pinned).model
    const created = build(
      ctx,
      [{ type: 'createTerminalTab', workspace: WS, afterTabId: editor }],
      closed
    )
    const tabId = created.results[0]!.tabId!
    expect(groupOrder(created.model)).toEqual([[editor, tabId, tabB]])
    expect(terminalTab(created.model, tabId).terminal.defaultTitle).toBe('Terminal 1')
  })

  it('moves a pane to a new tab keeping its id, so its data and scrollback move by structure', () => {
    const { model, tabA, leafA2, ctx } = setup()
    const workspace = model.workspaces[WS]!
    const paneData = { ptyId: 'pty-2', incarnationId: 'inc', title: 'logs' }
    const withData: WorkspaceLayoutModel = {
      ...model,
      workspaces: {
        [WS]: { ...workspace, leaves: { ...workspace.leaves, [leafA2]: paneData } }
      }
    }
    const moved = build(
      ctx,
      [{ type: 'movePaneToNewTab', workspace: WS, tabId: tabA, leafId: leafA2 }],
      withData
    )
    const newTabId = moved.results[0]!.tabId!
    expect(terminalTab(moved.model, newTabId).panes.root).toEqual({ type: 'leaf', leafId: leafA2 })
    expect(moved.model.workspaces[WS]!.leaves).toEqual(withData.workspaces[WS]!.leaves)
    const loaded = asLoaded(moved.model)
    loaded.facts.scrollback[leafA2] = { buffer: 'scrollback' }
    const saved = saveWorkspaceLayout(loaded)
    expect(saved.terminalLayoutsByTabId[newTabId]).toMatchObject({
      ptyIdsByLeafId: { [leafA2]: 'pty-2' },
      titlesByLeafId: { [leafA2]: 'logs' },
      buffersByLeafId: { [leafA2]: 'scrollback' }
    })
    expect(saved.terminalLayoutsByTabId[tabA]!.buffersByLeafId).toBeUndefined()
    expect(saved.terminalPtyIncarnationsByPaneKey).toEqual({ [`${newTabId}:${leafA2}`]: 'inc' })
    expect(groupOrder(moved.model)[0]!.indexOf(newTabId)).toBe(
      groupOrder(moved.model)[0]!.indexOf(tabA) + 1
    )
  })

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

    // Main's copy lacks the window's other panes, so the tab stays for them (no rule check: to
    // main's copy alone it reads as the tab re-ided).
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

  it('equalizes same-axis panes into equal shares', () => {
    const { model, tabA, leafA2, ctx } = setup()
    const three = build(
      ctx,
      [
        { type: 'splitPane', workspace: WS, tabId: tabA, leafId: leafA2, direction: 'vertical' },
        { type: 'equalizePanes', workspace: WS, tabId: tabA }
      ],
      model
    ).model
    const root = terminalTab(three, tabA).panes!.root!
    expect(root.type === 'split' && root.ratio).toBeCloseTo(1 / 3)
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

  const viewedOpens: [string, CommandOf<'openEditorTab'>, EditorTabView, string[]][] = [
    [
      'a diff tab',
      { type: 'openEditorTab', workspace: WS, fileId: '/w', contentType: 'diff' },
      { mode: 'diff', diffSource: 'combined-all', combinedAreaFilter: 'staged' },
      ['/w/a.ts']
    ],
    [
      'an edit tab with conflict details',
      {
        type: 'openEditorTab',
        workspace: WS,
        fileId: '/w/b.ts',
        contentType: 'editor',
        file: { filePath: '/w/b.ts', relativePath: 'b.ts', language: 'typescript' }
      },
      {
        mode: 'edit',
        conflict: {
          kind: 'conflict-editable',
          conflictKind: 'both_modified',
          conflictStatus: 'unresolved',
          conflictStatusSource: 'git'
        }
      },
      ['/w/a.ts', '/w/b.ts']
    ]
  ]

  it.each(viewedOpens)(
    '%s: holds its view by tab id, never saves it, and drops it on close',
    (_name, open, view, savedFiles) => {
      // Two identical setups mint identical ids, so only the view differs.
      const plainSetup = setup()
      const plain = build(plainSetup.ctx, [open], plainSetup.model)
      const viewedSetup = setup()
      const viewed = build(viewedSetup.ctx, [{ ...open, view }], viewedSetup.model)
      const tabId = viewed.results[0]!.tabId!
      expect(plain.results[0]!.tabId).toBe(tabId)
      expect(viewed.model.workspaces[WS]!.editorViews).toEqual({ [tabId]: view })

      const saved = saveWorkspaceLayout(asLoaded(viewed.model))
      expect(JSON.stringify(saved)).toBe(JSON.stringify(saveWorkspaceLayout(asLoaded(plain.model))))
      expect(saved.openFilesByWorktree?.[WS]?.map((file) => file.filePath)).toEqual(savedFiles)

      const closed = build(
        viewedSetup.ctx,
        [{ type: 'closeTabs', workspace: WS, tabIds: [tabId] }],
        viewed.model
      )
      expect(closed.model.workspaces[WS]!.editorViews).toEqual({})
    }
  )

  it('opens browser and agent-session tabs with their records', () => {
    const { model, ctx } = setup()
    const opened = build(
      ctx,
      [
        { type: 'openBrowserTab', workspace: WS, profileId: 'p1' },
        { type: 'openAgentSessionTab', workspace: WS, sessionId: 'sess-1', agent: 'codex' }
      ],
      model
    )
    const [browser, session] = opened.results
    expect(opened.model.workspaces[WS]!.browserTabs).toEqual([
      {
        id: browser!.tabId,
        sessionProfileId: 'p1',
        pageIds: [browser!.pageId],
        createdAt: expect.any(Number)
      }
    ])
    expect(
      opened.model.workspaces[WS]!.tabs.find((tab) => tab.id === session!.tabId)
    ).toMatchObject({ kind: 'agent-session', entityId: 'sess-1', agentSessionAgent: 'codex' })
  })

  it('creates a terminal tab at the time the window drew it, else now', () => {
    const ctx = testContext()
    const { model, results } = build(ctx, [
      { type: 'createTerminalTab', workspace: WS, createdAt: 42 },
      { type: 'createTerminalTab', workspace: WS }
    ])
    expect(terminalTab(model, results[0]!.tabId!).createdAt).toBe(42)
    expect(terminalTab(model, results[1]!.tabId!).createdAt).toBeGreaterThan(42)
  })

  it('creates a terminal tab with the quick command label the window drew it with', () => {
    const { model, results } = build(testContext(), [
      { type: 'createTerminalTab', workspace: WS, quickCommandLabel: 'Dev server' },
      { type: 'createTerminalTab', workspace: WS }
    ])
    expect(terminalTab(model, results[0]!.tabId!).quickCommandLabel).toBe('Dev server')
    expect(terminalTab(model, results[1]!.tabId!)).not.toHaveProperty('quickCommandLabel')
  })

  it('opens an editor tab at the time the window drew it, else now', () => {
    const ctx = testContext()
    const open = { type: 'openEditorTab', workspace: WS, contentType: 'editor' } as const
    const { model, results } = build(ctx, [
      { ...open, fileId: '/w/a.ts', createdAt: 42 },
      { ...open, fileId: '/w/b.ts' }
    ])
    const createdAt = (tabId: string) =>
      model.workspaces[WS]!.tabs.find((tab) => tab.id === tabId)!.createdAt
    expect(createdAt(results[0]!.tabId!)).toBe(42)
    expect(createdAt(results[1]!.tabId!)).toBeGreaterThan(42)
  })

  it('forgets an ended launch agent on a terminal tab only', () => {
    const ctx = testContext()
    const { model, results } = build(ctx, [
      { type: 'createTerminalTab', workspace: WS, creation: { launchAgent: 'claude' } },
      {
        type: 'openEditorTab',
        workspace: WS,
        fileId: '/w/a.ts',
        contentType: 'editor',
        file: { filePath: '/w/a.ts', relativePath: 'a.ts', language: 'typescript' }
      }
    ])
    const [terminal, editor] = results
    const cleared = build(
      ctx,
      [{ type: 'setTabProps', workspace: WS, tabId: terminal!.tabId!, clearLaunchAgent: true }],
      model
    ).model
    expect(terminalTab(cleared, terminal!.tabId!).terminal).toEqual({ defaultTitle: 'Terminal 1' })
    expect(
      refusal(model, {
        type: 'setTabProps',
        workspace: WS,
        tabId: editor!.tabId!,
        clearLaunchAgent: true
      })
    ).toBe('invalid_params')
  })
})
