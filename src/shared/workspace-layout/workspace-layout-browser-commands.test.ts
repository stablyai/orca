import { describe, expect, it } from 'vitest'
import { applyLayoutCommand } from './workspace-layout-commands'
import type { CommandOf, LayoutCommand } from './workspace-layout-command-types'
import { asLoaded, build, testContext, WS } from './workspace-layout-command.test-fixture'
import type { WorkspaceLayoutModel } from './workspace-layout-model'
import { saveWorkspaceLayout } from './workspace-layout-save'

const WINDOW_OPEN: CommandOf<'openBrowserTab'> = {
  type: 'openBrowserTab',
  workspace: WS,
  tabId: 'entry-1',
  browserTabId: 'browser-1',
  pageId: 'page-1',
  profileId: 'p1',
  sessionPartition: 'persist:p1'
}

/** A host's browser tab, then a window's. */
function setup() {
  const ctx = testContext()
  const { model, results } = build(ctx, [{ type: 'openBrowserTab', workspace: WS }, WINDOW_OPEN])
  return { ctx, model, hostTab: results[0]!.tabId! }
}

function outcome(model: WorkspaceLayoutModel, command: LayoutCommand) {
  const result = applyLayoutCommand(model, command, testContext())
  return result.ok ? result : result.code
}

const records = (model: WorkspaceLayoutModel) => model.workspaces[WS]!.browserTabs

describe('openBrowserTab under the window’s ids', () => {
  it('writes the tab-bar entry, the record and its page under those ids', () => {
    const { model } = setup()
    const workspace = model.workspaces[WS]!
    expect(workspace.tabs.at(-1)).toMatchObject({
      id: 'entry-1',
      kind: 'browser',
      entityId: 'browser-1'
    })
    expect(records(model)?.at(-1)).toEqual({
      id: 'browser-1',
      sessionProfileId: 'p1',
      sessionPartition: 'persist:p1',
      pageIds: ['page-1'],
      createdAt: expect.any(Number)
    })
    const saved = saveWorkspaceLayout(asLoaded(model))
    expect(saved.unifiedTabs?.[WS]?.at(-1)).toMatchObject({ id: 'entry-1', entityId: 'browser-1' })
    expect(saved.browserTabsByWorktree?.[WS]?.at(-1)).toMatchObject({ pageIds: ['page-1'] })
  })

  // Match window-created timestamps so its next save agrees with main’s copy.
  it('keeps the times the window drew the entry and the record at', () => {
    const { model } = build(testContext(), [
      { ...WINDOW_OPEN, createdAt: 1_700_000_000_001, browserCreatedAt: 1_700_000_000_000 }
    ])
    expect(model.workspaces[WS]!.tabs.at(-1)?.createdAt).toBe(1_700_000_000_001)
    expect(records(model)?.at(-1)?.createdAt).toBe(1_700_000_000_000)
  })

  it('places the tab where the window drew it', () => {
    const { ctx, model, hostTab } = setup()
    const placed = build(
      ctx,
      [
        { ...WINDOW_OPEN, tabId: 'entry-2', browserTabId: 'browser-2', pageId: 'p-2', index: 0 },
        {
          ...WINDOW_OPEN,
          tabId: 'entry-3',
          browserTabId: 'browser-3',
          pageId: 'p-3',
          afterTabId: hostTab
        }
      ],
      model
    ).model
    expect(placed.workspaces[WS]!.groups[0]!.tabOrder).toEqual([
      'entry-2',
      hostTab,
      'entry-3',
      'entry-1'
    ])
  })

  it('places a tab whose group main lacks in the workspace’s first group', () => {
    const { ctx, model } = setup()
    const split = build(
      ctx,
      [
        {
          type: 'splitGroup',
          workspace: WS,
          tabId: 'entry-1',
          besideGroupId: model.workspaces[WS]!.groups[0]!.id,
          direction: 'right'
        },
        {
          ...WINDOW_OPEN,
          tabId: 'entry-2',
          browserTabId: 'browser-2',
          pageId: 'p-2',
          groupId: 'unknown-group',
          afterTabId: 'entry-1'
        }
      ],
      model
    ).model
    expect(split.workspaces[WS]!.groups.map((group) => group.tabOrder)).toEqual([
      [expect.any(String), 'entry-2'],
      ['entry-1']
    ])
  })

  it('changes nothing when sent again, and refuses an id another tab or page holds', () => {
    const { model, hostTab } = setup()
    const again = outcome(model, WINDOW_OPEN)
    expect(again).toMatchObject({ result: { tabId: 'entry-1', pageId: 'page-1' } })
    expect(typeof again !== 'string' && again.model).toEqual(model)

    expect(outcome(model, { ...WINDOW_OPEN, browserTabId: 'browser-9', pageId: 'p-9' })).toBe(
      'tab_exists'
    )
    expect(outcome(model, { ...WINDOW_OPEN, tabId: 'entry-9', pageId: 'p-9' })).toBe('tab_exists')
    expect(outcome(model, { ...WINDOW_OPEN, tabId: hostTab, browserTabId: 'b-9' })).toBe(
      'tab_exists'
    )
    expect(outcome(model, { ...WINDOW_OPEN, tabId: 'entry-9', browserTabId: 'browser-9' })).toBe(
      'page_exists'
    )
  })
})

describe('browser tab record commands', () => {
  it('opens, replaces and closes pages in place', () => {
    const { ctx, model } = setup()
    const on = { workspace: WS, browserTabId: 'browser-1' }
    const next = build(
      ctx,
      [
        { type: 'openBrowserPage', ...on, pageId: 'page-2' },
        { type: 'openBrowserPage', ...on, pageId: 'page-2' },
        { type: 'replaceBrowserPage', ...on, pageId: 'page-1', newPageId: 'page-3' },
        { type: 'replaceBrowserPage', ...on, pageId: 'page-1', newPageId: 'page-3' }
      ],
      model
    ).model
    expect(records(next)?.at(-1)?.pageIds).toEqual(['page-3', 'page-2'])

    const closed = build(
      ctx,
      [
        { type: 'closeBrowserPage', ...on, pageId: 'page-3' },
        { type: 'closeBrowserPage', ...on, pageId: 'page-3' }
      ],
      next
    ).model
    expect(records(closed)?.at(-1)?.pageIds).toEqual(['page-2'])
  })

  it('refuses a page another tab holds, and a record the workspace lacks', () => {
    const { model, hostTab } = setup()
    const hostPage = records(model)![0]!.pageIds![0]!
    expect(hostTab).toBe(records(model)![0]!.id)
    const on = { workspace: WS, browserTabId: 'browser-1' }
    expect(outcome(model, { type: 'openBrowserPage', ...on, pageId: hostPage })).toBe('page_exists')
    expect(
      outcome(model, { type: 'replaceBrowserPage', ...on, pageId: 'page-1', newPageId: hostPage })
    ).toBe('page_exists')
    expect(
      outcome(model, { type: 'closeBrowserPage', workspace: WS, browserTabId: 'gone', pageId: 'x' })
    ).toBe('tab_not_found')
  })

  it('switches the tab’s profile', () => {
    const { ctx, model } = setup()
    const next = build(
      ctx,
      [
        {
          type: 'setBrowserTabProfile',
          workspace: WS,
          browserTabId: 'browser-1',
          profileId: null,
          sessionPartition: null
        }
      ],
      model
    ).model
    expect(records(next)?.at(-1)).toMatchObject({ sessionProfileId: null, sessionPartition: null })
  })
})
