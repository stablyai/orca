import { describe, expect, it } from 'vitest'

import './old-client-session-tab-rows'
import {
  projectSessionTabs,
  type SessionTabsFacts,
  type SessionTabsView
} from './old-client-session-tabs-projection'
import '../persistence/workspace-layout-beside'
import '../editor-tabs/workspace-layout-editor-tab-file'
import { build, testContext, WS } from '../commands/workspace-layout-command.test-fixture'
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
  it.each(['check-details', 'conflict-review'] as const)(
    'withholds %s views from file rows and group references',
    (mode) => {
      const { model, results } = build(testContext(), [
        {
          type: 'openEditorTab',
          workspace: WS,
          fileId: `${WS}::${mode}::check-run:42`,
          contentType: mode,
          view: {
            view: { mode },
            file: {
              filePath: `${WS}::${mode}::check-run:42`,
              relativePath: 'e2e / changed e2e specs (1/1)',
              language: 'plaintext'
            }
          }
        },
        {
          type: 'openEditorTab',
          workspace: WS,
          fileId: '/Users/dev/orca/app.ts',
          contentType: 'editor',
          file: {
            filePath: '/Users/dev/orca/app.ts',
            relativePath: 'app.ts',
            language: 'typescript'
          }
        }
      ])
      const virtualTabId = results[0]!.tabId!
      const fileTabId = results[1]!.tabId!
      const groupId = groupOf(model, virtualTabId)
      const view = views({
        activeGroupIdByWorktree: { [WS]: groupId },
        groups: {
          [WS]: {
            [groupId]: { activeTabId: virtualTabId, recentTabIds: [fileTabId, virtualTabId] }
          }
        }
      })

      const snapshot = projectSessionTabs(WS, model.workspaces[WS]!, view, noFacts, false)

      expect(snapshot.tabs).toMatchObject([
        { id: fileTabId, type: 'file', relativePath: 'app.ts', isActive: false }
      ])
      expect(snapshot.tabs).toHaveLength(1)
      expect(snapshot.activeTabId).toBeNull()
      expect(snapshot.activeTabType).toBeNull()
      expect(snapshot.tabGroups).toEqual([
        { id: groupId, activeTabId: null, tabOrder: [fileTabId], recentTabIds: [fileTabId] }
      ])
    }
  )

  it('names the first group active when the saved one is gone, as a window restores it', () => {
    const { model, left } = workspace()
    const view = views({ activeGroupIdByWorktree: { [WS]: 'group-gone' } })
    expect(projectSessionTabs(WS, model.workspaces[WS]!, view, noFacts, false).activeGroupId).toBe(
      left
    )
  })
})
