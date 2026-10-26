import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../runtime-session-contracts'
import { resolveSessionTabRow } from './old-client-session-tab-rows'
import {
  projectSessionTabs,
  type SessionTabsFacts,
  type SessionTabsView
} from './old-client-session-tabs-projection'
import { BLANK_BROWSER_TAB_STATE } from '../workspace-layout-beside'
import { editorFileKey } from '../workspace-layout-editor-tab-file'
import { build, testContext, WS } from '../workspace-layout-command.test-fixture'
import type { WorkspaceLayoutModel } from '../workspace-layout-model'

/** Desktop-shaped fixture: split/agent terminals, file, browser and chat across two groups, with one titled pane. */
function workspace() {
  const ctx = testContext()
  const { model, results } = build(ctx, [
    { type: 'createTerminalTab', workspace: WS, title: 'api server' },
    {
      type: 'createTerminalTab',
      workspace: WS,
      creation: { launchAgent: 'claude', startupCwd: '/Users/dev/orca' }
    },
    {
      type: 'openEditorTab',
      workspace: WS,
      fileId: '/Users/dev/orca/README.md',
      contentType: 'editor',
      file: {
        filePath: '/Users/dev/orca/README.md',
        relativePath: 'README.md',
        language: 'markdown'
      }
    },
    { type: 'openBrowserTab', workspace: WS },
    { type: 'openAgentSessionTab', workspace: WS, sessionId: 'session-1', agent: 'codex' }
  ])
  const [api, agent, readme, browser, chat] = results
  const left = groupOf(model, api!.tabId!)
  const arranged = build(
    ctx,
    [
      {
        type: 'splitPane',
        workspace: WS,
        tabId: api!.tabId!,
        leafId: api!.leafId!,
        direction: 'vertical'
      },
      {
        type: 'renamePane',
        workspace: WS,
        tabId: api!.tabId!,
        leafId: api!.leafId!,
        title: 'logs'
      },
      { type: 'setTabProps', workspace: WS, tabId: api!.tabId!, color: '#ff0000', isPinned: true },
      {
        type: 'splitGroup',
        workspace: WS,
        tabId: browser!.tabId!,
        besideGroupId: left,
        direction: 'right'
      }
    ],
    model
  )
  const apiSplit = arranged.results[0]!.leafId!
  const right = arranged.results[3]!.groupId!
  const moved = build(
    ctx,
    [{ type: 'moveTab', workspace: WS, tabId: chat!.tabId!, toGroupId: right, index: 1 }],
    arranged.model
  ).model
  const ws = moved.workspaces[WS]!
  const bound: WorkspaceLayoutModel = {
    ...moved,
    workspaces: {
      [WS]: {
        ...ws,
        leaves: {
          ...ws.leaves,
          [api!.leafId!]: { ...ws.leaves?.[api!.leafId!], ptyId: 'pty-1', incarnationId: 'inc-1' },
          [apiSplit]: { ptyId: 'pty-2' }
        }
      }
    }
  }
  return { model: bound, api, apiSplit, agent, readme, browser, chat, left, right }
}

function groupOf(model: WorkspaceLayoutModel, tabId: string): string {
  return model.workspaces[WS]!.groups.find((group) => group.tabOrder.includes(tabId))!.id
}

function views(fields: Partial<SessionTabsView> = {}): SessionTabsView {
  return { groups: {}, panes: {}, editorDrafts: {}, ...fields }
}

const noFacts: SessionTabsFacts = { tabLabels: {}, terminalRows: {}, browserTabs: {} }

describe('projectSessionTabs', () => {
  it("projects the model into today's snapshot rows, groups and selection", () => {
    const { model, api, apiSplit, agent, readme, browser, chat, left, right } = workspace()
    const apiTab = api!.tabId!
    const view = views({
      activeGroupIdByWorktree: { [WS]: left },
      groups: {
        [WS]: {
          [left]: { activeTabId: apiTab, recentTabIds: [agent!.tabId!, apiTab, 'gone'] },
          [right]: { activeTabId: chat!.tabId! }
        }
      },
      panes: { [apiTab]: { activeLeafId: apiSplit, expandedLeafId: null } },
      // Keyed as editorFileKey keys it (an owned id in a layout-owner build), as the Loader does.
      editorDrafts: {
        [WS]: {
          [editorFileKey({ filePath: '/Users/dev/orca/README.md' })]: {
            dirtyDraftContent: '# draft'
          }
        }
      }
    })
    const facts: SessionTabsFacts = {
      tabLabels: {},
      terminalRows: { [agent!.tabId!]: { title: 'Claude Code' } },
      browserTabs: {
        [WS]: {
          [browser!.tabId!]: {
            ...BLANK_BROWSER_TAB_STATE,
            activePageId: 'page-live',
            url: 'https://example.com',
            title: 'Example'
          }
        }
      }
    }
    const parentLayout = {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: api!.leafId! },
        second: { type: 'leaf', leafId: apiSplit }
      },
      activeLeafId: apiSplit,
      expandedLeafId: null,
      ptyIdsByLeafId: { [api!.leafId!]: 'pty-1', [apiSplit]: 'pty-2' },
      titlesByLeafId: { [api!.leafId!]: 'logs' }
    } as const
    const expected: Omit<RuntimeMobileSessionTabsSnapshot, 'publicationEpoch' | 'snapshotVersion'> =
      {
        worktree: WS,
        activeGroupId: left,
        activeTabId: `${apiTab}::${apiSplit}`,
        activeTabType: 'terminal',
        tabGroups: [
          {
            id: left,
            activeTabId: apiTab,
            tabOrder: [apiTab, agent!.tabId!, readme!.tabId!],
            recentTabIds: [agent!.tabId!, apiTab]
          },
          {
            id: right,
            activeTabId: 'agent-session:session-1',
            tabOrder: [browser!.tabId!, 'agent-session:session-1'],
            recentTabIds: []
          }
        ],
        tabGroupLayout: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', groupId: left },
          second: { type: 'leaf', groupId: right }
        },
        tabs: [
          {
            type: 'terminal',
            id: `${apiTab}::${api!.leafId!}`,
            title: 'logs',
            customTitle: 'api server',
            parentTabId: apiTab,
            leafId: api!.leafId!,
            ptyId: 'pty-1',
            incarnationId: 'inc-1',
            parentLayout,
            color: '#ff0000',
            isPinned: true,
            isActive: false
          },
          {
            type: 'terminal',
            id: `${apiTab}::${apiSplit}`,
            title: 'Terminal',
            customTitle: 'api server',
            parentTabId: apiTab,
            leafId: apiSplit,
            ptyId: 'pty-2',
            parentLayout,
            color: '#ff0000',
            isPinned: true,
            isActive: true
          },
          {
            type: 'terminal',
            id: `${agent!.tabId!}::${agent!.leafId!}`,
            title: 'Claude Code',
            customTitle: null,
            parentTabId: agent!.tabId!,
            leafId: agent!.leafId!,
            launchAgent: 'claude',
            startupCwd: '/Users/dev/orca',
            parentLayout: {
              root: { type: 'leaf', leafId: agent!.leafId! },
              activeLeafId: agent!.leafId!,
              expandedLeafId: null
            },
            isActive: false
          },
          {
            type: 'markdown',
            id: readme!.tabId!,
            title: 'README.md',
            filePath: '/Users/dev/orca/README.md',
            relativePath: 'README.md',
            language: 'markdown',
            mode: 'edit',
            isDirty: true,
            isActive: false,
            sourceFileId: '/Users/dev/orca/README.md',
            sourceFilePath: '/Users/dev/orca/README.md',
            sourceRelativePath: 'README.md',
            documentVersion: 'file:/Users/dev/orca/README.md',
            color: null,
            isPinned: false
          },
          {
            type: 'browser',
            id: browser!.tabId!,
            title: 'Example',
            browserWorkspaceId: browser!.tabId!,
            browserPageId: 'page-live',
            url: 'https://example.com',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            color: null,
            isPinned: false,
            isActive: false
          },
          {
            type: 'agent-session',
            id: 'agent-session:session-1',
            title: 'Codex Chat',
            sessionId: 'session-1',
            agent: 'codex',
            isActive: false
          }
        ]
      }
    expect(projectSessionTabs(WS, model.workspaces[WS]!, view, facts, false)).toEqual(expected)
  })

  describe("titles follow today's order", () => {
    function soleTab(fields: { title?: string; paneTitle?: string; live?: string }) {
      const ctx = testContext()
      const created = build(ctx, [
        {
          type: 'createTerminalTab',
          workspace: WS,
          ...(fields.title ? { title: fields.title } : {})
        }
      ])
      const { tabId, leafId } = created.results[0]!
      const model = fields.paneTitle
        ? build(
            ctx,
            [
              {
                type: 'renamePane',
                workspace: WS,
                tabId: tabId!,
                leafId: leafId!,
                title: fields.paneTitle
              }
            ],
            created.model
          ).model
        : created.model
      const facts = fields.live
        ? { ...noFacts, terminalRows: { [tabId!]: { title: fields.live } } }
        : noFacts
      return { model, tabId: tabId!, facts }
    }
    const titleOf = (
      { model, facts }: ReturnType<typeof soleTab>,
      generatedTitlesEnabled = false
    ) =>
      projectSessionTabs(WS, model.workspaces[WS]!, views(), facts, generatedTitlesEnabled).tabs[0]!
        .title

    it('a custom title beats the pane title and the live title (#19582)', () => {
      expect(titleOf(soleTab({ title: 'deploy', paneTitle: 'logs', live: 'zsh' }))).toBe('deploy')
    })

    it('a pane title beats the live title when there is no custom title', () => {
      expect(titleOf(soleTab({ paneTitle: 'logs', live: 'zsh' }))).toBe('logs')
    })

    it('reads generated titles only with the setting on', () => {
      const tab = soleTab({ live: 'zsh' })
      const ws = tab.model.workspaces[WS]!
      const generated = {
        ...tab,
        model: {
          ...tab.model,
          workspaces: {
            [WS]: {
              ...ws,
              tabs: ws.tabs.map((entry) => ({ ...entry, generatedTitle: 'Fix login' }))
            }
          }
        }
      }
      expect(titleOf(generated)).toBe('zsh')
      expect(titleOf(generated, true)).toBe('Fix login')
    })

    it('a quick-command label beats the live title', () => {
      const tab = soleTab({ live: 'zsh' })
      const ws = tab.model.workspaces[WS]!
      const labelled = {
        ...tab,
        model: {
          ...tab.model,
          workspaces: {
            [WS]: {
              ...ws,
              tabs: ws.tabs.map((entry) => ({ ...entry, quickCommandLabel: 'Tests' }))
            }
          }
        }
      }
      const row = projectSessionTabs(
        WS,
        labelled.model.workspaces[WS]!,
        views(),
        labelled.facts,
        false
      ).tabs[0]
      expect(row).toMatchObject({ title: 'Tests', quickCommandLabel: 'Tests' })
    })

    it('split panes show their own title or "Terminal", never the tab title', () => {
      const { model, api } = workspace()
      const rows = projectSessionTabs(WS, model.workspaces[WS]!, views(), noFacts, true).tabs
      expect(rows.filter((row) => row.id.startsWith(api!.tabId!)).map((row) => row.title)).toEqual([
        'logs',
        'Terminal'
      ])
    })
  })

  it('names the first group but no tab active when the view selects nothing, and keeps one group without a tree', () => {
    const ctx = testContext()
    const { model } = build(ctx, [{ type: 'createTerminalTab', workspace: WS }])
    const projected = projectSessionTabs(WS, model.workspaces[WS]!, views(), noFacts, false)
    expect(projected).toMatchObject({
      activeGroupId: model.workspaces[WS]!.groups[0]!.id,
      activeTabId: null,
      activeTabType: null
    })
    expect(projected.tabGroups).toHaveLength(1)
    expect(projected).not.toHaveProperty('tabGroupLayout')
    expect(projected.tabs[0]).toMatchObject({ title: 'Terminal 1', isActive: false })
  })

  it('names the first group active when the saved one is gone, as a window restores it', () => {
    const { model, left } = workspace()
    const view = views({ activeGroupIdByWorktree: { [WS]: 'group-gone' } })
    expect(projectSessionTabs(WS, model.workspaces[WS]!, view, noFacts, false).activeGroupId).toBe(
      left
    )
  })

  it('round-trips every row id to the tab (and pane) it names', () => {
    const { model, api, apiSplit } = workspace()
    const ws = model.workspaces[WS]!
    for (const row of projectSessionTabs(WS, ws, views(), noFacts, false).tabs) {
      const target = resolveSessionTabRow(ws, row.id)
      expect(target, row.id).not.toBeNull()
      if (row.type === 'terminal') {
        expect(target).toEqual({
          tab: expect.objectContaining({ entityId: row.parentTabId }),
          leafId: row.leafId
        })
      }
    }
    expect(resolveSessionTabRow(ws, `${api!.tabId!}::${apiSplit}`)?.leafId).toBe(apiSplit)
    expect(resolveSessionTabRow(ws, `${api!.tabId!}::not-a-pane`)).toBeNull()
  })
})
