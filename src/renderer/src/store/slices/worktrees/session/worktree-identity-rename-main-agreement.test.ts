// A worktree identity rename re-keys the layout twice: main migrates its stored sessions first,
// then the window re-keys its slices on the `worktrees:changed` rename event. The window's next
// save must leave main's layout model as main's own migration left it, and both must match the
// model's `identityRenamed` transition, so the save is never the only carrier of the rekey.
// The event's one producer is the first-work folder rename (first-work-folder-rename.ts), local
// only and compiled off (ENABLE_FIRST_WORK_FOLDER_RENAME); a paired server's event carries no rename.
import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { getDefaultPersistedState } from '../../../../../../shared/constants'
import type { WorkspaceSessionState } from '../../../../../../shared/workspace-session-state-types'
import {
  addWorkspace,
  emptySession,
  leaf
} from '../../../../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { applyLayoutTransition } from '../../../../../../shared/workspace-layout/workspace-layout-transitions'
import { migrateWorktreeIdentity } from '../../../../../../main/persistence/tracking-repos/worktree-identity-migration'
import { loadWorkspaceLayoutWithoutReport } from '../../../../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../../../../shared/workspace-layout/workspace-layout-minted-ids'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

// @ts-expect-error -- mocked browser preload API
globalThis.window = { api: {} }

import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { createTestStore, makeWorktree } from '../../store-test-helpers'

const REPO = 'repo1'
const OLD = `${REPO}::/path/cunner`
const NEW = `${REPO}::/path/spinner`
const OTHER = `${REPO}::/path/other`
const EDITOR_FILE = '/path/cunner/src/App.tsx'

function sessionBeforeRename(): WorkspaceSessionState {
  const session = addWorkspace(emptySession(), OLD, [
    {
      id: 'group-left',
      tabs: [
        { id: 'tab-split', leaves: [[leaf(1), 'pty-1'], [leaf(2)]] },
        { id: 'tab-two', leaves: [[leaf(3), 'pty-3']] },
        { id: EDITOR_FILE, kind: 'editor' }
      ]
    },
    {
      id: 'group-right',
      tabs: [
        { id: 'tab-right', leaves: [[leaf(4)]] },
        { id: 'browser-1', kind: 'browser' }
      ]
    }
  ])
  session.openFilesByWorktree = {
    [OLD]: [
      {
        filePath: EDITOR_FILE,
        relativePath: 'src/App.tsx',
        worktreeId: OLD,
        language: 'typescript'
      }
    ]
  }
  session.activeFileIdByWorktree = { [OLD]: EDITOR_FILE }
  session.browserTabsByWorktree = {
    [OLD]: [
      {
        id: 'browser-1',
        worktreeId: OLD,
        url: 'https://example.com',
        title: 'Example',
        loading: false,
        faviconUrl: null,
        canGoBack: false,
        canGoForward: false,
        loadError: null,
        createdAt: 3
      }
    ]
  }
  addWorkspace(session, OTHER, [
    { id: 'group-other', tabs: [{ id: 'tab-other', leaves: [[leaf(5)]] }] }
  ])
  session.activeRepoId = REPO
  session.activeWorktreeId = OLD
  return session
}

/** Main's layout model of a stored partition, loaded as main loads it. */
function layoutModelOf(session: WorkspaceSessionState) {
  return loadWorkspaceLayoutWithoutReport('local', session, nameBasedLoadContext()).layout
}

function hydratedWindow(session: WorkspaceSessionState) {
  const store = createTestStore()
  store.setState({
    repos: [{ id: REPO, path: '/path', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }],
    worktreesByRepo: {
      [REPO]: [OLD, OTHER].map((id) =>
        makeWorktree({ id, repoId: REPO, path: id.slice(`${REPO}::`.length) })
      )
    }
  })
  store.getState().hydrateWorkspaceSession(session)
  store.getState().hydrateTabsSession(session)
  store.getState().hydrateEditorSession(session)
  store.getState().hydrateBrowserSession(session)
  store.setState({ workspaceSessionReady: true })
  store.getState().setHydrationSucceeded(true)
  return store
}

describe('worktree identity rename: window and main agree on the layout', () => {
  it("leaves main's migrated layout model as it is when the window saves its rekey", () => {
    const store = hydratedWindow(sessionBeforeRename())
    // What main holds: the window's last save before the rename.
    const held = buildWorkspaceSessionPayload(store.getState())
    const before = layoutModelOf(held)
    expect(Object.keys(before.workspaces).sort()).toEqual([OLD, OTHER].sort())

    // Main: Store.migrateWorktreeIdentity, before it sends the rename event.
    const persisted = {
      ...getDefaultPersistedState('/home'),
      workspaceSession: structuredClone(held)
    }
    expect(migrateWorktreeIdentity(persisted, OLD, NEW)).toBe(true)
    const mainModel = layoutModelOf(persisted.workspaceSession)

    // Window: the rename event re-keys its slices; the worktree list then catches up.
    store.getState().migrateWorktreeIdentity(OLD, NEW)
    store.setState({
      worktreesByRepo: {
        [REPO]: [NEW, OTHER].map((id) =>
          makeWorktree({ id, repoId: REPO, path: id.slice(`${REPO}::`.length) })
        )
      }
    })
    const windowModel = layoutModelOf(buildWorkspaceSessionPayload(store.getState()))

    expect(Object.keys(mainModel.workspaces).sort()).toEqual([NEW, OTHER].sort())
    const renamed = windowModel.workspaces[NEW]!
    expect(renamed.tabs.length).toBe(5)
    expect(renamed.groups?.length).toBe(2)
    expect(renamed.editorFiles?.length).toBe(1)
    expect(renamed.browserTabs?.length).toBe(1)
    expect({ workspaces: windowModel.workspaces, records: windowModel.records }).toEqual({
      workspaces: mainModel.workspaces,
      records: mainModel.records
    })

    const transitioned = applyLayoutTransition(before, {
      type: 'identityRenamed',
      from: OLD,
      to: NEW
    })
    expect(transitioned.ok).toBe(true)
    if (transitioned.ok) {
      expect(transitioned.model.workspaces).toEqual(mainModel.workspaces)
      expect(transitioned.model.records).toEqual(mainModel.records)
    }
  })
})
