import { describe, expect, it } from 'vitest'
import { MoveTab } from '../../rpc-contract/session-tabs-schemas-params'
import { TerminalCreateParams } from '../../rpc-contract/terminal-unary-params'
import {
  translateCreateTerminalTab,
  translateSessionTabClose,
  translateSessionTabMove,
  translateSetTabProps,
  translateTerminalClose,
  translateTerminalCloseTab,
  translateTerminalCreate,
  translateTerminalRename,
  translateTerminalSplit,
  type MethodTranslation
} from './old-client-method-translation'
import { translateUpdatePaneLayout } from './old-client-pane-layout-translation'
import { terminalRowId } from './old-client-session-tab-rows'
import { projectSessionTabs } from './old-client-session-tabs-projection'
import { applyLayoutCommand } from '../workspace-layout-commands'
import { build, terminalTab, testContext, WS } from '../workspace-layout-command.test-fixture'
import type { LayoutCommand } from '../workspace-layout-command-types'
import type { WorkspaceLayoutModel } from '../workspace-layout-model'

const NEW_LEAF = '99999999-9999-4999-8999-999999999999'
const NO_VIEW = { groups: {}, panes: {}, editorDrafts: {} }
const NO_FACTS = { tabLabels: {}, terminalRows: {}, browserTabs: {} }

/** Two terminal tabs and a browser tab in one group; the second terminal tab is pinned. */
function setup() {
  const ctx = testContext()
  const { model, results } = build(ctx, [
    { type: 'createTerminalTab', workspace: WS },
    { type: 'createTerminalTab', workspace: WS },
    { type: 'openBrowserTab', workspace: WS }
  ])
  const [first, second, browser] = results
  const pinned = build(
    ctx,
    [{ type: 'setTabProps', workspace: WS, tabId: second!.tabId!, isPinned: true }],
    model
  )
  return {
    ctx,
    model: pinned.model,
    tabA: first!.tabId!,
    leafA: first!.leafId!,
    tabB: second!.tabId!,
    leafB: second!.leafId!,
    browser: browser!.tabId!
  }
}

function commandsOf(translation: MethodTranslation): LayoutCommand[] {
  if (!translation.ok) {
    throw new Error(`refused: ${translation.code}`)
  }
  return translation.commands
}

/** Parse terminal.create as an older desktop pane transport sends it. */
function createParams(fields: { tabId?: string; leafId?: string; title?: string }) {
  return TerminalCreateParams.parse({
    worktree: `id:${WS}`,
    focus: false,
    presentation: 'background',
    ...fields
  })
}

describe('translateTerminalCreate', () => {
  it('starts a pane the model already has', () => {
    const { model, tabA, leafA } = setup()
    expect(
      translateTerminalCreate(model, WS, createParams({ tabId: tabA, leafId: leafA }))
    ).toEqual({
      ok: true,
      commands: [{ type: 'startPane', workspace: WS, paneKey: `${tabA}:${leafA}` }]
    })
  })

  it('splits a tab the model has for a pane it does not, keeping the sent pane id', () => {
    const { ctx, model, tabA, leafA } = setup()
    const commands = commandsOf(
      translateTerminalCreate(model, WS, createParams({ tabId: tabA, leafId: NEW_LEAF }))
    )
    expect(commands).toEqual([
      {
        type: 'splitPane',
        workspace: WS,
        tabId: tabA,
        leafId: leafA,
        direction: 'vertical',
        newLeafId: NEW_LEAF
      }
    ])
    expect(terminalTab(build(ctx, commands, model).model, tabA).panes.root).toEqual({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: leafA },
      second: { type: 'leaf', leafId: NEW_LEAF }
    })
  })

  it('places the new pane where the desktop drew it once its tree arrives', () => {
    const { ctx, model, tabA, leafA } = setup()
    const split = build(
      ctx,
      commandsOf(
        translateTerminalCreate(model, WS, createParams({ tabId: tabA, leafId: NEW_LEAF }))
      ),
      model
    ).model
    // The desktop split down, not right.
    const drawn = {
      type: 'split' as const,
      direction: 'horizontal' as const,
      ratio: 0.5,
      first: { type: 'leaf' as const, leafId: leafA },
      second: { type: 'leaf' as const, leafId: NEW_LEAF }
    }
    const translation = translateUpdatePaneLayout(
      WS,
      split.workspaces[WS]!,
      terminalTab(split, tabA),
      {
        root: drawn
      }
    )
    expect(translation.structureRefused).toBe(false)
    expect(terminalTab(build(ctx, translation.commands, split).model, tabA).panes.root).toEqual(
      drawn
    )
  })

  it('creates a tab with unused ids', () => {
    const { model } = setup()
    expect(
      translateTerminalCreate(
        model,
        WS,
        createParams({ tabId: 'tab-new', leafId: NEW_LEAF, title: 'api' })
      )
    ).toEqual({
      ok: true,
      commands: [
        {
          type: 'createTerminalTab',
          workspace: WS,
          tabId: 'tab-new',
          leafId: NEW_LEAF,
          title: 'api'
        }
      ]
    })
  })

  it.each([
    ['no ids (CLI, orchestration)', {}],
    ['a tab id alone', { tabId: 'tab-new' }],
    ['a pane id that is not a UUID', { tabId: 'tab-new', leafId: 'pane:1' }],
    ['a web surface tab id', { tabId: 'web-terminal-surface-1', leafId: NEW_LEAF }]
  ])('mints ids for %s, as allocateTerminalPaneIdentity does', (_, fields) => {
    const { model } = setup()
    expect(translateTerminalCreate(model, WS, createParams(fields))).toEqual({
      ok: true,
      commands: [{ type: 'createTerminalTab', workspace: WS }]
    })
  })

  it('refuses a pane id another tab holds, and a tab id that is not a terminal', () => {
    const { model, tabA, leafB, browser } = setup()
    expect(
      translateTerminalCreate(model, WS, createParams({ tabId: tabA, leafId: leafB }))
    ).toEqual({
      ok: false,
      code: 'invalid_params'
    })
    expect(
      translateTerminalCreate(model, WS, createParams({ tabId: 'tab-new', leafId: leafB }))
    ).toEqual({ ok: false, code: 'invalid_params' })
    expect(
      translateTerminalCreate(model, WS, createParams({ tabId: browser, leafId: NEW_LEAF }))
    ).toEqual({ ok: false, code: 'invalid_params' })
  })

  it('creates into a workspace the model does not have yet', () => {
    const { model } = setup()
    expect(
      translateTerminalCreate(
        model,
        'repo-2::/w',
        createParams({ tabId: 'tab-new', leafId: NEW_LEAF })
      )
    ).toEqual({
      ok: true,
      commands: [
        { type: 'createTerminalTab', workspace: 'repo-2::/w', tabId: 'tab-new', leafId: NEW_LEAF }
      ]
    })
  })
})

describe('session.tabs translations', () => {
  it('closes a split pane row as its pane; a pinned tab refuses its tab row and last-pane row', () => {
    const { ctx, model, tabA, leafA, tabB, leafB, browser } = setup()
    const pinnedSplit = build(
      ctx,
      [
        { type: 'splitPane', workspace: WS, tabId: tabA, leafId: leafA, direction: 'vertical' },
        { type: 'setTabProps', workspace: WS, tabId: tabA, isPinned: true },
        { type: 'setTabProps', workspace: WS, tabId: browser, isPinned: true }
      ],
      model
    ).model
    const workspace = pinnedSplit.workspaces[WS]!
    // A pane of a split tab closes even when the tab is pinned, as today.
    expect(translateSessionTabClose(WS, workspace, { tabId: terminalRowId(tabA, leafA) })).toEqual({
      ok: true,
      commands: [{ type: 'closePane', workspace: WS, tabId: tabA, leafId: leafA }]
    })
    for (const tabId of [tabB, terminalRowId(tabB, leafB)]) {
      const commands = commandsOf(translateSessionTabClose(WS, workspace, { tabId }))
      expect(commands).toEqual([
        { type: 'closeTabs', workspace: WS, tabIds: [tabB], refusePinned: true }
      ])
      const result = applyLayoutCommand(pinnedSplit, commands[0]!, ctx)
      expect(result.ok && result.result.refused).toEqual([{ tabId: tabB, code: 'tab_pinned' }])
    }
    // Only terminal tabs check the pin today; a pinned browser tab closes.
    expect(commandsOf(translateSessionTabClose(WS, workspace, { tabId: browser }))).toEqual([
      { type: 'closeTabs', workspace: WS, tabIds: [browser] }
    ])
  })

  it('closes a row that is already gone as already closed', () => {
    const { ctx, model } = setup()
    const commands = commandsOf(
      translateSessionTabClose(WS, model.workspaces[WS], { tabId: 'gone::leaf' })
    )
    expect(commands).toEqual([{ type: 'closeTabs', workspace: WS, tabIds: ['gone::leaf'] }])
    const closed = applyLayoutCommand(model, commands[0]!, ctx)
    expect(closed.ok && closed.result.closed).toEqual(['gone::leaf'])
  })

  it('sets props on the tab a pane row names', () => {
    const { model, tabA, leafA } = setup()
    expect(
      translateSetTabProps(WS, model.workspaces[WS]!, {
        tabId: terminalRowId(tabA, leafA),
        color: null,
        viewMode: 'chat'
      })
    ).toEqual({
      ok: true,
      commands: [{ type: 'setTabProps', workspace: WS, tabId: tabA, color: null, viewMode: 'chat' }]
    })
    expect(
      translateSetTabProps(WS, model.workspaces[WS]!, { tabId: 'gone', isPinned: true })
    ).toEqual({ ok: true, commands: [] })
  })

  it('creates a terminal tab after the tab a row names', () => {
    const { model, tabA, leafA } = setup()
    expect(
      translateCreateTerminalTab(WS, model.workspaces[WS], {
        afterTabId: terminalRowId(tabA, leafA),
        targetGroupId: 'group-1',
        viewMode: 'terminal'
      })
    ).toEqual({
      ok: true,
      commands: [
        {
          type: 'createTerminalTab',
          workspace: WS,
          afterTabId: tabA,
          groupId: 'group-1',
          viewMode: 'terminal'
        }
      ]
    })
  })
})

describe('session.tabs.move translation', () => {
  function groupOrder(model: WorkspaceLayoutModel, groupId: string) {
    return model.workspaces[WS]!.groups.find((group) => group.id === groupId)!.tabOrder
  }

  /** Translate against the snapshot the client saw, matching the handler. */
  function move(model: WorkspaceLayoutModel, params: Record<string, unknown>) {
    const workspace = model.workspaces[WS]!
    const shown = projectSessionTabs(WS, workspace, NO_VIEW, NO_FACTS, false)
    return translateSessionTabMove(WS, workspace, shown, MoveTab.parse({ worktree: WS, ...params }))
  }

  it('turns a full reorder into the moves that produce it', () => {
    const { ctx, model, tabA, leafA, tabB, browser } = setup()
    const group = model.workspaces[WS]!.groups[0]!
    const commands = commandsOf(
      move(model, {
        tabId: browser,
        targetGroupId: group.id,
        kind: 'reorder',
        tabOrder: [browser, terminalRowId(tabA, leafA), tabB]
      })
    )
    expect(groupOrder(build(ctx, commands, model).model, group.id)).toEqual([browser, tabA, tabB])
    // Each step names the tab before its slot in the wanted order, so main places it there.
    expect(commands.map((command) => command.type === 'moveTab' && command.afterTabId)).toEqual(
      commands.map((command) =>
        command.type === 'moveTab' && command.index > 0
          ? [browser, tabA, tabB][command.index - 1]
          : null
      )
    )
  })

  it.each([
    ['a partial order', (ids: string[]) => ids.slice(1)],
    ['a repeated tab', (ids: string[]) => [ids[0]!, ids[0]!, ids[1]!]],
    ['an unknown tab', (ids: string[]) => [...ids.slice(0, 2), 'gone']]
  ])('refuses %s with invalid_tab_order, as today', (_, edit) => {
    const { model } = setup()
    const group = model.workspaces[WS]!.groups[0]!
    expect(
      move(model, {
        tabId: group.tabOrder[0],
        targetGroupId: group.id,
        kind: 'reorder',
        tabOrder: edit(group.tabOrder)
      })
    ).toEqual({ ok: false, code: 'invalid_tab_order' })
  })

  it("refuses a tab outside the reordered group and an unknown group with today's codes", () => {
    const { ctx, model, tabA, tabB } = setup()
    const sourceGroup = model.workspaces[WS]!.groups[0]!.id
    const splitOff = build(
      ctx,
      [
        {
          type: 'splitGroup',
          workspace: WS,
          tabId: tabB,
          besideGroupId: sourceGroup,
          direction: 'right'
        }
      ],
      model
    )
    const target = splitOff.results[0]!.groupId!
    expect(
      move(splitOff.model, {
        tabId: tabA,
        targetGroupId: target,
        kind: 'reorder',
        tabOrder: [tabB]
      })
    ).toEqual({ ok: false, code: 'invalid_tab_order' })
    expect(move(model, { tabId: tabA, targetGroupId: 'gone', kind: 'move-to-group' })).toEqual({
      ok: false,
      code: 'target_group_not_found'
    })
    expect(
      move(model, { tabId: 'gone', targetGroupId: sourceGroup, kind: 'move-to-group' })
    ).toEqual({ ok: false, code: 'tab_not_found' })
  })

  it('maps move-to-group (shown index to full index) and split', () => {
    const { model, tabA, browser } = setup()
    const workspace = model.workspaces[WS]!
    const groupId = workspace.groups[0]!.id
    const base = { tabId: browser, targetGroupId: groupId }
    expect(move(model, { ...base, kind: 'move-to-group' })).toEqual({
      ok: true,
      commands: [
        {
          type: 'moveTab',
          workspace: WS,
          toGroupId: groupId,
          tabId: browser,
          index: 3,
          afterTabId: workspace.groups[0]!.tabOrder[2]
        }
      ]
    })
    expect(move(model, { ...base, kind: 'move-to-group', index: 1 })).toEqual({
      ok: true,
      commands: [
        {
          type: 'moveTab',
          workspace: WS,
          toGroupId: groupId,
          tabId: browser,
          index: 1,
          afterTabId: workspace.groups[0]!.tabOrder[0]
        }
      ]
    })
    expect(move(model, { ...base, tabId: tabA, kind: 'split', splitDirection: 'down' })).toEqual({
      ok: true,
      commands: [
        {
          type: 'splitGroup',
          workspace: WS,
          tabId: tabA,
          besideGroupId: groupId,
          direction: 'down'
        }
      ]
    })
  })
})

describe('terminal.close and terminal.closeTab keep the pinned refusal', () => {
  it('refuses a pinned tab and its last pane, and closes a pane of a split tab', () => {
    const { ctx, model, tabA, leafA, tabB, leafB } = setup()
    const pinnedPane = { tab: terminalTab(model, tabB), leafId: leafB }
    for (const translation of [
      translateTerminalCloseTab(WS, pinnedPane),
      translateTerminalClose(WS, pinnedPane)
    ]) {
      const commands = commandsOf(translation)
      expect(commands).toEqual([
        { type: 'closeTabs', workspace: WS, tabIds: [tabB], refusePinned: true }
      ])
      const result = applyLayoutCommand(model, commands[0]!, ctx)
      expect(result.ok && result.result.refused).toEqual([{ tabId: tabB, code: 'tab_pinned' }])
    }
    const split = build(
      ctx,
      [{ type: 'splitPane', workspace: WS, tabId: tabA, leafId: leafA, direction: 'vertical' }],
      model
    ).model
    expect(
      commandsOf(translateTerminalClose(WS, { tab: terminalTab(split, tabA), leafId: leafA }))
    ).toEqual([{ type: 'closePane', workspace: WS, tabId: tabA, leafId: leafA }])
  })
})

describe('terminal.* translations on a resolved pane', () => {
  it('splits below by default and resets an empty title', () => {
    const { model, tabA, leafA } = setup()
    const pane = { tab: terminalTab(model, tabA), leafId: leafA }
    expect(commandsOf(translateTerminalSplit(WS, pane, undefined))).toEqual([
      { type: 'splitPane', workspace: WS, tabId: tabA, leafId: leafA, direction: 'horizontal' }
    ])
    expect(commandsOf(translateTerminalRename(WS, pane, ''))).toEqual([
      { type: 'renameTab', workspace: WS, tabId: tabA, kind: 'custom', title: null }
    ])
    expect(commandsOf(translateTerminalRename(WS, pane, 'api'))).toEqual([
      { type: 'renameTab', workspace: WS, tabId: tabA, kind: 'custom', title: 'api' }
    ])
  })
})
