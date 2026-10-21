// Two editor tabs for one file in one group (layout-owner builds): a layout-owner window draws only
// one, so a close could not reach the other. Main never makes the second, and folds a saved one.
import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../layout-owner-switch'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import { applyLayoutCommand } from './workspace-layout-commands'
import { build, testContext, WS } from './workspace-layout-command.test-fixture'
import { loadWorkspaceLayout } from './workspace-layout-load'
import { addWorkspace, emptySession, GIT_KEY } from './workspace-layout-session.test-fixture'

const FILE = '/repo/a.ts'

/** A legacy session: the file's tab twice in one group, the later one selected and most recent. */
function savedTwice(): WorkspaceSessionState {
  const session = addWorkspace(emptySession(), GIT_KEY, [
    {
      id: 'g1',
      activeTabId: 'ed-2',
      recent: ['ed-1', 'ed-2'],
      tabs: [
        { id: 'ed-1', entityId: FILE, kind: 'editor' },
        { id: 'ed-2', entityId: FILE, kind: 'editor' },
        { id: 'ed-b', entityId: '/repo/b.ts', kind: 'editor' }
      ]
    }
  ])
  session.openFilesByWorktree = {
    [GIT_KEY]: ['a.ts', 'b.ts'].map((name) => ({
      filePath: `/repo/${name}`,
      relativePath: name,
      worktreeId: GIT_KEY,
      language: 'typescript'
    }))
  }
  return session
}

function load(session: WorkspaceSessionState) {
  let next = 0
  return loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, session, {
    mintId: () => `minted-${++next}`,
    mintLeafId: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`
  })
}

describe.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
  'one file, one tab per group (layout-owner build)',
  () => {
    it("folds a saved session's second tab for a file into the first, as the window's restore does", () => {
      const loaded = load(savedTwice())

      const workspace = loaded.layout.workspaces[GIT_KEY]!
      expect(workspace.tabs.map((tab) => tab.id)).toEqual(['ed-1', 'ed-b'])
      expect(workspace.groups).toEqual([{ id: 'g1', tabOrder: ['ed-1', 'ed-b'] }])
      // The selection and history that named the folded tab name the kept one.
      expect(loaded.desktopView.groups[GIT_KEY]!.g1).toEqual({
        activeTabId: 'ed-1',
        recentTabIds: ['ed-1', 'ed-1']
      })
    })

    it("refuses to move a tab into a group that already shows the tab's file", () => {
      const ctx = testContext()
      const left = build(ctx, [
        {
          type: 'openEditorTab',
          workspace: WS,
          tabId: 'left',
          fileId: FILE,
          contentType: 'editor'
        },
        {
          type: 'openEditorTab',
          workspace: WS,
          tabId: 'other',
          fileId: '/repo/b.ts',
          contentType: 'editor'
        }
      ])
      const leftGroup = left.model.workspaces[WS]!.groups[0]!
      const split = build(
        ctx,
        [
          {
            type: 'splitGroup',
            workspace: WS,
            tabId: 'other',
            besideGroupId: leftGroup.id,
            direction: 'right'
          }
        ],
        left.model
      )
      const rightGroup = split.model.workspaces[WS]!.groups.find(
        (group) => group.id !== leftGroup.id
      )!
      const opened = build(
        ctx,
        [
          {
            type: 'openEditorTab',
            workspace: WS,
            tabId: 'right',
            fileId: FILE,
            contentType: 'editor',
            groupId: rightGroup.id
          }
        ],
        split.model
      )

      expect(
        applyLayoutCommand(
          opened.model,
          { type: 'moveTab', workspace: WS, tabId: 'right', toGroupId: leftGroup.id, index: 0 },
          ctx
        )
      ).toEqual({ ok: false, code: 'tab_exists' })
    })
  }
)

describe.skipIf(ORCA_LAYOUT_OWNER_IS_MAIN)('one file, one tab per group, switch off', () => {
  it('loads a saved second tab as before', () => {
    const workspace = load(savedTwice()).layout.workspaces[GIT_KEY]!
    expect(workspace.tabs.map((tab) => tab.id)).toEqual(['ed-1', 'ed-2', 'ed-b'])
  })
})
