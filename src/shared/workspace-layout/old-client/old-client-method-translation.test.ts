import { describe, expect, it } from 'vitest'
import { MoveTab } from '../../rpc-contract/session-tabs/session-tabs-schemas-params'
import { TerminalCreateParams } from '../../rpc-contract/terminal/terminal-unary-params'
import { translateSessionTabMove, translateTerminalCreate } from './old-client-method-translation'
import './old-client-pane-layout-translation'
import './old-client-session-row-ids'
import { projectSessionTabs } from './old-client-session-tabs-projection'
import '../workspace-layout-commands'
import { build, testContext, WS } from '../commands/workspace-layout-command.test-fixture'

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
})

describe('session.tabs.move translation', () => {
  /** Translate against the snapshot the client saw, matching the handler. */
  function move(model: WorkspaceLayoutModel, params: Record<string, unknown>) {
    const workspace = model.workspaces[WS]!
    const shown = projectSessionTabs(WS, workspace, NO_VIEW, NO_FACTS, false)
    return translateSessionTabMove(WS, workspace, shown, MoveTab.parse({ worktree: WS, ...params }))
  }

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
})
