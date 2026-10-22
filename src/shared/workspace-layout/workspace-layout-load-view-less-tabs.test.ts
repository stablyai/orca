// Layout-owner build (L286): main's layout load, given its views, drops the saved tabs the window's
// restore drops (restoresSavedContentTab), so main never holds a tab no window draws.

import { describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../execution-host'
import type { Tab, TabContentType } from '../tab-types'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../constants'
import { translateSessionTabMove } from './old-client/old-client-method-translation'
import { loadWorkspaceLayout } from './workspace-layout-load'
import { nameBasedLoadContext } from './workspace-layout-minted-ids'
import { saveWorkspaceLayout } from './workspace-layout-save'

vi.mock('../layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const KEY = 'repo-1::/w'

function entry(id: string, contentType: TabContentType, entityId: string, sortOrder: number): Tab {
  return {
    id,
    entityId,
    groupId: 'g1',
    worktreeId: KEY,
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: 1
  }
}

/** A saved session after a restart: two edit files, and tabs whose documents were never saved. */
function savedSession(): WorkspaceSessionState {
  const tabs = [
    entry('ghost-diff', 'diff', '/w/gone.ts', 0),
    entry('ed-a', 'editor', '/w/a.ts', 1),
    entry('ghost-review', 'conflict-review', '/w/conflict', 2),
    entry('ghost-checks', 'check-details', '/w/checks', 3),
    entry('ghost-html', 'editor', 'html-preview::/w/page.html', 4),
    entry('kept-diff', 'diff', '/w/b.ts', 5),
    entry('ed-b', 'editor', '/w/b.ts', 6)
  ]
  return {
    ...getDefaultWorkspaceSession(),
    unifiedTabs: { [KEY]: tabs },
    tabGroups: {
      [KEY]: [{ id: 'g1', worktreeId: KEY, activeTabId: 'ed-a', tabOrder: tabs.map((t) => t.id) }]
    },
    openFilesByWorktree: {
      [KEY]: ['/w/a.ts', '/w/b.ts'].map((filePath) => ({
        filePath,
        relativePath: filePath.slice(3),
        worktreeId: KEY,
        language: 'typescript'
      }))
    }
  }
}

// Main's projection and command applies carry its views; after a restart it holds none.
const load = (session: WorkspaceSessionState) =>
  loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, session, {
    ...nameBasedLoadContext(),
    editorViewsOf: () => undefined
  })

describe("main's layout load of view-less saved editor tabs", () => {
  it('drops the tabs the window drops and keeps a diff of a saved edit file', () => {
    const workspace = load(savedSession()).layout.workspaces[KEY]!

    expect(workspace.groups.map((group) => group.tabOrder)).toEqual([['ed-a', 'kept-diff', 'ed-b']])
    expect(workspace.tabs.map((tab) => tab.id).sort()).toEqual(['ed-a', 'ed-b', 'kept-diff'])
  })

  it('writes the drop back on its next save, and a reload does not bring them back', () => {
    const saved = saveWorkspaceLayout(load(savedSession()))

    expect(saved.unifiedTabs?.[KEY]?.map((tab) => tab.id)).toEqual(['ed-a', 'kept-diff', 'ed-b'])
    expect(saved.tabGroups?.[KEY]?.[0]?.tabOrder).toEqual(['ed-a', 'kept-diff', 'ed-b'])
    expect(load(saved).changes).toEqual([])
  })

  // Main's own edits (a phone's browser tab, an agent tab) load without its views: they must not
  // drop a live diff whose view only main's memory holds.
  it('keeps every saved tab in a load that carries no views', () => {
    const workspace = loadWorkspaceLayout(
      LOCAL_EXECUTION_HOST_ID,
      savedSession(),
      nameBasedLoadContext()
    ).layout.workspaces[KEY]!

    expect(workspace.tabs).toHaveLength(7)
  })

  it('keeps a transient tab while main still holds its view', () => {
    const workspace = loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, savedSession(), {
      ...nameBasedLoadContext(),
      editorViewsOf: () => ({
        'ghost-diff': {
          view: { mode: 'diff' },
          file: { filePath: '/w/gone.ts', relativePath: 'gone.ts', language: 'typescript' }
        }
      })
    }).layout.workspaces[KEY]!

    expect(workspace.groups[0]?.tabOrder).toEqual(['ghost-diff', 'ed-a', 'kept-diff', 'ed-b'])
  })

  it("does not count a view-less tab in a client's move index", () => {
    const workspace = load(savedSession()).layout.workspaces[KEY]!
    // The rows a client was shown: the window draws no view-less tab either.
    const shown = { id: 'g1', activeTabId: 'ed-a', tabOrder: ['ed-a', 'kept-diff', 'ed-b'] }

    const translation = translateSessionTabMove(
      KEY,
      workspace,
      { tabGroups: [shown] },
      { kind: 'move-to-group', tabId: 'ed-b', targetGroupId: 'g1', index: 0 }
    )

    expect(translation).toMatchObject({ ok: true, commands: [{ type: 'moveTab', index: 0 }] })
  })
})
