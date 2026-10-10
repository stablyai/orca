import { describe, expect, it } from 'vitest'
import { applyLayoutCommand } from './workspace-layout-commands'
import type { LayoutCommand } from './workspace-layout-command-types'
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

  it('movePaneToNewTab refuses the last pane, which moves as a tab instead', () => {
    const { model, tabB, leafB } = setup()
    expect(
      refusal(model, { type: 'movePaneToNewTab', workspace: WS, tabId: tabB, leafId: leafB })
    ).toBe('last_pane')
  })

  it('setPaneRatios accepts divider sizes only', () => {
    const { model, tabA, leafA, leafA2 } = setup()
    const root = terminalTab(model, tabA).panes!.root!
    if (root.type !== 'split') {
      throw new Error('expected a split')
    }
    expect(
      refusal(model, {
        type: 'setPaneRatios',
        workspace: WS,
        tabId: tabA,
        root: { ...root, ratio: 0.3 }
      })
    ).toBe('applied')
    const swapped = {
      type: 'split' as const,
      direction: 'vertical' as const,
      first: { type: 'leaf' as const, leafId: leafA2 },
      second: { type: 'leaf' as const, leafId: leafA }
    }
    expect(
      refusal(model, { type: 'setPaneRatios', workspace: WS, tabId: tabA, root: swapped })
    ).toBe('pane_structure_changed')
    expect(
      refusal(model, {
        type: 'setPaneRatios',
        workspace: WS,
        tabId: tabA,
        root: { type: 'leaf', leafId: leafA }
      })
    ).toBe('pane_structure_changed')
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
})
