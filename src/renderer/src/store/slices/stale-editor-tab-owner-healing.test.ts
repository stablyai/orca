import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Tab } from '../../../../shared/tab-types'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../../../shared/workspace-session-state-types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { buildEditorSessionData } from '@/lib/workspace-session'
import {
  resolveWorktreeOperationRouteResult,
  type WorktreeOperationRouteState
} from '@/lib/worktree-operation-route'
import {
  alignHealedEditorTabHosts,
  resolveHealableWorktreeOwnerRoute
} from './editor/file-ids/hydrated-editor-owner-healing'
import type { OpenFile } from './editor'
import { createStoreSessionMockApi } from './store-session-test-harness'
import { createTestStore, makeWorktree } from './store-test-helpers'
import {
  buildStaleEditorTabSession,
  STALE_TAB_BRAND_COMPOSITE_TAB_ID,
  STALE_TAB_BRAND_PATH,
  STALE_TAB_BRAND_PLAIN_TAB_ID,
  STALE_TAB_CSV_PATH,
  STALE_TAB_CSV_TAB_ID,
  STALE_TAB_REPO_ID,
  STALE_TAB_RUNTIME_ENV_ID,
  STALE_TAB_WORKTREE_ID,
  STALE_TAB_WORKTREE_PATH
} from './stale-editor-tab-resurrection-fixture'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreSessionMockApi()

const RUNTIME_HOST_ID: ExecutionHostId = `runtime:${STALE_TAB_RUNTIME_ENV_ID}`

function prepareStore(hostIds: readonly (ExecutionHostId | undefined)[]) {
  const store = createTestStore()
  store.setState({
    repos: [
      {
        id: STALE_TAB_REPO_ID,
        path: STALE_TAB_WORKTREE_PATH,
        displayName: 'eppo',
        badgeColor: '#000',
        addedAt: 0
      }
    ],
    worktreesByRepo: {
      [STALE_TAB_REPO_ID]: hostIds.map((hostId) =>
        makeWorktree({
          id: STALE_TAB_WORKTREE_ID,
          repoId: STALE_TAB_REPO_ID,
          path: STALE_TAB_WORKTREE_PATH,
          hostId
        })
      )
    },
    activeWorktreeId: STALE_TAB_WORKTREE_ID,
    // The focus selection that stamped the corrupt rows must not decide the heal.
    activeWorkspaceExecutionHostId: RUNTIME_HOST_ID
  })
  return store
}

function hydrate(store: ReturnType<typeof prepareStore>, session: WorkspaceSessionState) {
  store.getState().hydrateTabsSession(session)
  store.getState().hydrateEditorSession(session)
  return store.getState()
}

describe('stale editor tab owner healing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('collapses runtime-stamped duplicates onto the local route of a local worktree', () => {
    const state = hydrate(prepareStore(['local']), buildStaleEditorTabSession())

    expect(state.openFiles.map((file) => [file.filePath, file.runtimeEnvironmentId])).toEqual([
      [STALE_TAB_CSV_PATH, null],
      [STALE_TAB_BRAND_PATH, null]
    ])
    expect(state.openFiles.map((file) => file.id)).toEqual([
      STALE_TAB_CSV_PATH,
      STALE_TAB_BRAND_PATH
    ])
    const tabs = state.unifiedTabsByWorktree[STALE_TAB_WORKTREE_ID] ?? []
    expect(tabs.map((tab) => tab.entityId)).toEqual([STALE_TAB_CSV_PATH, STALE_TAB_BRAND_PATH])
    expect(tabs.map((tab) => tab.executionHostId)).toEqual(['local', 'local'])
    const group = state.groupsByWorktree[STALE_TAB_WORKTREE_ID][0]
    const tabIds = new Set(tabs.map((tab) => tab.id))
    expect(group.tabOrder.every((tabId) => tabIds.has(tabId))).toBe(true)
    expect(group.recentTabIds?.every((tabId) => tabIds.has(tabId))).toBe(true)
    expect(state.activeFileIdByWorktree[STALE_TAB_WORKTREE_ID]).toBe(STALE_TAB_BRAND_PATH)
  })

  it('redirects the tab of a single re-owned record instead of orphaning it', () => {
    const session = buildStaleEditorTabSession()
    const records = session.openFilesByWorktree![STALE_TAB_WORKTREE_ID]!
    session.openFilesByWorktree![STALE_TAB_WORKTREE_ID] = [records[0]]
    const tabs = session.unifiedTabs![STALE_TAB_WORKTREE_ID]!
    session.unifiedTabs![STALE_TAB_WORKTREE_ID] = [{ ...tabs[0], entityId: STALE_TAB_CSV_TAB_ID }]
    const state = hydrate(prepareStore(['local']), session)

    expect(state.openFiles.map((file) => [file.id, file.runtimeEnvironmentId])).toEqual([
      [STALE_TAB_CSV_PATH, null]
    ])
    expect(
      (state.unifiedTabsByWorktree[STALE_TAB_WORKTREE_ID] ?? []).map((tab) => tab.entityId)
    ).toEqual([STALE_TAB_CSV_PATH])
  })

  it('leaves an unstamped editor tab unstamped while healing its owner', () => {
    const session = buildStaleEditorTabSession()
    session.unifiedTabs![STALE_TAB_WORKTREE_ID] = session.unifiedTabs![STALE_TAB_WORKTREE_ID]!.map(
      ({ executionHostId: _stampedByFocus, ...tab }) => tab
    )
    const state = hydrate(prepareStore(['local']), session)

    const tabs = state.unifiedTabsByWorktree[STALE_TAB_WORKTREE_ID] ?? []
    expect(tabs.map((tab) => tab.executionHostId)).toEqual([undefined, undefined])
    expect(state.openFiles.map((file) => file.runtimeEnvironmentId)).toEqual([null, null])
  })

  it('collapses onto the runtime owner when the worktree really is runtime-owned', () => {
    const state = hydrate(prepareStore([RUNTIME_HOST_ID]), buildStaleEditorTabSession())

    expect(state.openFiles.map((file) => [file.filePath, file.runtimeEnvironmentId])).toEqual([
      [STALE_TAB_CSV_PATH, STALE_TAB_RUNTIME_ENV_ID],
      [STALE_TAB_BRAND_PATH, STALE_TAB_RUNTIME_ENV_ID]
    ])
    const tabs = state.unifiedTabsByWorktree[STALE_TAB_WORKTREE_ID] ?? []
    expect(tabs.map((tab) => tab.executionHostId)).toEqual([RUNTIME_HOST_ID, RUNTIME_HOST_ID])
    const openFileIds = new Set(state.openFiles.map((file) => file.id))
    expect(tabs.every((tab) => openFileIds.has(tab.entityId))).toBe(true)
  })

  it('keeps persisted owners verbatim when the worktree route is ambiguous', () => {
    const state = hydrate(prepareStore(['local', RUNTIME_HOST_ID]), buildStaleEditorTabSession())

    // The runtime-stamped csv keeps its persisted owner: an unplaceable worktree is no evidence.
    expect(state.openFiles.map((file) => [file.filePath, file.runtimeEnvironmentId])).toEqual([
      [STALE_TAB_CSV_PATH, STALE_TAB_RUNTIME_ENV_ID],
      [STALE_TAB_BRAND_PATH, null]
    ])
    const tabs = state.unifiedTabsByWorktree[STALE_TAB_WORKTREE_ID] ?? []
    expect(tabs.map((tab) => tab.executionHostId)).toEqual([RUNTIME_HOST_ID, RUNTIME_HOST_ID])
  })

  it('never rewrites a read-only live-tail log pinned to the client-local host', () => {
    const session = buildStaleEditorTabSession()
    session.openFilesByWorktree![STALE_TAB_WORKTREE_ID] = [
      {
        filePath: '/Users/tester/.orca/logs/session.log',
        relativePath: '/Users/tester/.orca/logs/session.log',
        worktreeId: STALE_TAB_WORKTREE_ID,
        language: 'plaintext',
        runtimeEnvironmentId: null,
        readOnly: true,
        liveTail: true
      }
    ]
    const state = hydrate(prepareStore([RUNTIME_HOST_ID]), session)

    expect(state.openFiles.map((file) => file.runtimeEnvironmentId)).toEqual([null])
  })

  it('keeps both records when two duplicates carry divergent unsaved drafts', () => {
    const session = buildStaleEditorTabSession()
    const [csv, brandLocal, brandRuntime] = session.openFilesByWorktree![STALE_TAB_WORKTREE_ID]
    session.openFilesByWorktree![STALE_TAB_WORKTREE_ID] = [
      csv,
      { ...brandLocal, dirtyDraftContent: 'draft from the local pane' },
      { ...brandRuntime, dirtyDraftContent: 'draft from the runtime pane' }
    ]
    const state = hydrate(prepareStore(['local']), session)

    expect(state.openFiles.map((file) => [file.filePath, file.runtimeEnvironmentId])).toEqual([
      [STALE_TAB_CSV_PATH, null],
      [STALE_TAB_BRAND_PATH, null],
      [STALE_TAB_BRAND_PATH, STALE_TAB_RUNTIME_ENV_ID]
    ])
    expect(Object.values(state.editorDrafts).sort()).toEqual([
      'draft from the local pane',
      'draft from the runtime pane'
    ])
  })

  it('never re-stamps the tab of a divergent-draft survivor that kept its own owner', () => {
    const session = buildStaleEditorTabSession()
    const [csv, brandLocal, brandRuntime] = session.openFilesByWorktree![STALE_TAB_WORKTREE_ID]
    session.openFilesByWorktree![STALE_TAB_WORKTREE_ID] = [
      csv,
      { ...brandLocal, dirtyDraftContent: 'draft from the local pane' },
      { ...brandRuntime, dirtyDraftContent: 'draft from the runtime pane' }
    ]
    const tabs = session.unifiedTabs![STALE_TAB_WORKTREE_ID]!
    // The runtime pane's tab names that record's own owned id, so it follows the runtime survivor.
    session.unifiedTabs![STALE_TAB_WORKTREE_ID] = tabs.map((tab) =>
      tab.id === STALE_TAB_BRAND_COMPOSITE_TAB_ID
        ? { ...tab, entityId: STALE_TAB_BRAND_COMPOSITE_TAB_ID }
        : tab
    )
    const state = hydrate(prepareStore(['local']), session)

    const stampByTabId = new Map(
      (state.unifiedTabsByWorktree[STALE_TAB_WORKTREE_ID] ?? []).map((tab) => [
        tab.id,
        tab.executionHostId ?? null
      ])
    )
    expect(stampByTabId.get(STALE_TAB_BRAND_COMPOSITE_TAB_ID)).toBe(RUNTIME_HOST_ID)
    expect(stampByTabId.get(STALE_TAB_BRAND_PLAIN_TAB_ID)).toBe('local')
  })

  it('survives a write/restore round trip of two same-owner divergent drafts', () => {
    const liveFile = (id: string, isDirty: boolean): OpenFile => ({
      id,
      filePath: STALE_TAB_BRAND_PATH,
      relativePath: 'sandbox/2026-09-16-listings-survey/handout/brand-requests.txt',
      worktreeId: STALE_TAB_WORKTREE_ID,
      language: 'plaintext',
      mode: 'edit',
      isDirty,
      isPreview: false,
      runtimeEnvironmentId: null,
      lastKnownDiskSignature: 'sig-1'
    })
    const written = buildEditorSessionData(
      [liveFile(STALE_TAB_BRAND_PATH, true), liveFile('editor:second-pane', true)],
      { [STALE_TAB_BRAND_PATH]: 'left text', 'editor:second-pane': 'right text' },
      {},
      {},
      {}
    )
    // The writer keeps both rows; the restore has one id for them, so the loser must stay recoverable.
    expect(written.openFilesByWorktree?.[STALE_TAB_WORKTREE_ID]).toHaveLength(2)

    const session = buildStaleEditorTabSession()
    session.openFilesByWorktree = written.openFilesByWorktree
    const store = prepareStore(['local'])
    const state = hydrate(store, session)

    const restored = state.openFiles.find((file) => file.filePath === STALE_TAB_BRAND_PATH)
    expect(state.editorDrafts[restored!.id]).toBe('left text')
    expect(state.recentlyClosedEditorTabsByWorktree[STALE_TAB_WORKTREE_ID]).toEqual([
      expect.objectContaining({
        filePath: STALE_TAB_BRAND_PATH,
        dirtyDraftContent: 'right text',
        lastKnownDiskSignature: 'sig-1'
      })
    ])

    // Once the user saves the survivor, reopen recovers the parked draft onto that record and must
    // re-verify the baseline it derives from, exactly as hydrating a dirty record does.
    store.getState().clearEditorDraft(restored!.id)
    store.getState().markFileDirty(restored!.id, false)
    // The saved tab re-baselined off its own disk read, and its verification already cleared.
    store.getState().setLastKnownDiskSignature(restored!.id, 'sig-2')
    store.getState().clearPendingDiskBaselineVerification(restored!.id)
    expect(store.getState().reopenClosedEditorTab(STALE_TAB_WORKTREE_ID)).toBe(true)

    expect(
      store.getState().openFiles.find((file) => file.filePath === STALE_TAB_BRAND_PATH)
    ).toMatchObject({
      lastKnownDiskSignature: 'sig-1',
      pendingDiskBaselineVerification: true
    })
  })

  it('keeps the only unsaved draft among clean duplicates', () => {
    const session = buildStaleEditorTabSession()
    const records = session.openFilesByWorktree![STALE_TAB_WORKTREE_ID]
    records[2] = {
      ...records[2],
      dirtyDraftContent: '',
      lastKnownDiskSignature: 'sig-1'
    }
    const state = hydrate(prepareStore(['local']), session)

    const brand = state.openFiles.find((file) => file.filePath === STALE_TAB_BRAND_PATH)
    expect(brand?.isDirty).toBe(true)
    expect(brand?.lastKnownDiskSignature).toBe('sig-1')
    expect(state.editorDrafts[brand!.id]).toBe('')
  })

  it('keeps the disk baseline an equal-draft duplicate carries', () => {
    const session = buildStaleEditorTabSession()
    const records = session.openFilesByWorktree![STALE_TAB_WORKTREE_ID]
    records[2] = { ...records[2], dirtyDraftContent: 'same text' }
    records[4] = {
      ...records[4],
      dirtyDraftContent: 'same text',
      lastKnownDiskSignature: 'sig-1'
    }
    const state = hydrate(prepareStore(['local']), session)

    const brand = state.openFiles.find((file) => file.filePath === STALE_TAB_BRAND_PATH)
    expect(state.editorDrafts[brand!.id]).toBe('same text')
    expect(brand?.lastKnownDiskSignature).toBe('sig-1')
    expect(brand?.pendingDiskBaselineVerification).toBe(true)
  })
})

const FOLDER_WORKSPACE_ID = 'folder-1'
const FOLDER_WORKSPACE_KEY = folderWorkspaceKey(FOLDER_WORKSPACE_ID)
const FOLDER_FILE_PATH = '/srv/work/notes.md'

function prepareFolderStore(executionHostId?: ExecutionHostId) {
  const store = createTestStore()
  store.setState({
    folderWorkspaces: [
      {
        id: FOLDER_WORKSPACE_ID,
        projectGroupId: 'project-group-1',
        name: 'Folder',
        folderPath: '/srv/work',
        connectionId: null,
        ...(executionHostId ? { executionHostId } : {}),
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        createdAt: 1,
        updatedAt: 1
      }
    ],
    projectGroups: [],
    activeWorktreeId: FOLDER_WORKSPACE_KEY,
    // Focus and the focused runtime are the only "evidence" an unstamped folder row has.
    activeWorkspaceExecutionHostId: RUNTIME_HOST_ID
  })
  return store
}

function folderSession(runtimeEnvironmentIds: readonly (string | null)[]): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: FOLDER_WORKSPACE_KEY,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    openFilesByWorktree: {
      [FOLDER_WORKSPACE_KEY]: runtimeEnvironmentIds.map((runtimeEnvironmentId) => ({
        filePath: FOLDER_FILE_PATH,
        relativePath: 'notes.md',
        worktreeId: FOLDER_WORKSPACE_KEY,
        language: 'markdown',
        runtimeEnvironmentId
      }))
    },
    activeFileIdByWorktree: {},
    activeTabTypeByWorktree: {}
  }
}

const BRAND_RELATIVE_PATH = 'sandbox/2026-09-16-listings-survey/handout/brand-requests.txt'

function brandRow(overrides: Partial<PersistedOpenFile>): PersistedOpenFile {
  return {
    filePath: STALE_TAB_BRAND_PATH,
    relativePath: BRAND_RELATIVE_PATH,
    worktreeId: STALE_TAB_WORKTREE_ID,
    language: 'plaintext',
    runtimeEnvironmentId: null,
    ...overrides
  }
}

function hydrateBrandRows(rows: readonly PersistedOpenFile[]) {
  const session = buildStaleEditorTabSession()
  session.openFilesByWorktree![STALE_TAB_WORKTREE_ID] = [...rows]
  return hydrate(prepareStore(['local']), session)
}

describe('recovered draft parking at hydration', () => {
  it('never parks a read-only row draft that would come back writable', () => {
    const state = hydrateBrandRows([
      brandRow({ readOnly: true, liveTail: true, dirtyDraftContent: 'log draft A' }),
      brandRow({ readOnly: true, liveTail: true, dirtyDraftContent: 'log draft B' })
    ])

    expect(state.openFiles.map((file) => [file.id, file.readOnly === true, file.isDirty])).toEqual([
      [STALE_TAB_BRAND_PATH, true, false]
    ])
    expect(state.editorDrafts).toEqual({})
    expect(state.recentlyClosedEditorTabsByWorktree[STALE_TAB_WORKTREE_ID] ?? []).toEqual([])
  })

  it('parks the rival draft when both duplicates are writable', () => {
    const state = hydrateBrandRows([
      brandRow({ dirtyDraftContent: 'draft A' }),
      brandRow({ dirtyDraftContent: 'draft B' })
    ])

    expect(state.editorDrafts[STALE_TAB_BRAND_PATH]).toBe('draft A')
    expect(
      (state.recentlyClosedEditorTabsByWorktree[STALE_TAB_WORKTREE_ID] ?? []).map(
        (snapshot) => snapshot.dirtyDraftContent
      )
    ).toEqual(['draft B'])
  })

  it('parks the draft of a writable row a read-only row for its path displaced', () => {
    const state = hydrateBrandRows([
      brandRow({ readOnly: true, liveTail: true }),
      brandRow({ dirtyDraftContent: 'unsaved edit' })
    ])

    // Both rows resolve to the same owned id, so only the first restores as a record.
    expect(state.openFiles.map((file) => [file.id, file.readOnly === true, file.isDirty])).toEqual([
      [STALE_TAB_BRAND_PATH, true, false]
    ])
    expect(state.editorDrafts).toEqual({})
    expect(
      (state.recentlyClosedEditorTabsByWorktree[STALE_TAB_WORKTREE_ID] ?? []).map(
        (snapshot) => snapshot.dirtyDraftContent
      )
    ).toEqual(['unsaved edit'])
    expect(state.recentlyClosedTabKindsByWorktree[STALE_TAB_WORKTREE_ID]).toEqual(['editor'])
  })

  it('leaves the draft on the record when the writable row restores first', () => {
    const state = hydrateBrandRows([
      brandRow({ dirtyDraftContent: 'unsaved edit' }),
      brandRow({ readOnly: true, liveTail: true })
    ])

    expect(state.openFiles.map((file) => [file.id, file.readOnly === true, file.isDirty])).toEqual([
      [STALE_TAB_BRAND_PATH, false, true]
    ])
    expect(state.editorDrafts[STALE_TAB_BRAND_PATH]).toBe('unsaved edit')
    expect(state.recentlyClosedEditorTabsByWorktree[STALE_TAB_WORKTREE_ID] ?? []).toEqual([])
  })
})

describe('healed editor tab host alignment', () => {
  const HUB_ENVIRONMENT_ID = 'hub-env-1'
  const SSH_HOST_ID: ExecutionHostId = 'ssh:conn-1'
  const SSH_HUB_ROUTE = { executionHostId: SSH_HOST_ID, runtimeEnvironmentId: HUB_ENVIRONMENT_ID }

  function stampedTab(executionHostId: ExecutionHostId): Tab {
    return {
      id: 'tab-1',
      entityId: 'file-1',
      groupId: 'group-1',
      worktreeId: 'wt-1',
      executionHostId,
      contentType: 'editor',
      label: 'a.txt',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    }
  }

  function align(tab: Tab) {
    return alignHealedEditorTabHosts(
      { 'wt-1': [tab] },
      { 'wt-1': { fileIds: new Set(['file-1']), route: SSH_HUB_ROUTE } }
    )
  }

  it('leaves a tab stamped with the hub that transports an ssh route untouched', () => {
    expect(align(stampedTab(`runtime:${HUB_ENVIRONMENT_ID}`))).toBeNull()
    expect(align(stampedTab(SSH_HOST_ID))).toBeNull()
  })

  it('still re-stamps a tab naming a host the route contradicts', () => {
    expect(align(stampedTab('runtime:other-env'))?.['wt-1'][0].executionHostId).toBe(SSH_HOST_ID)
  })
})

describe('folder workspace owner healing', () => {
  it('heals onto a stamped local folder owner', () => {
    const store = prepareFolderStore('local')
    store.getState().hydrateEditorSession(folderSession([STALE_TAB_RUNTIME_ENV_ID]))

    expect(store.getState().openFiles.map((file) => file.runtimeEnvironmentId)).toEqual([null])
  })

  it('heals onto a stamped runtime folder owner', () => {
    const store = prepareFolderStore(RUNTIME_HOST_ID)
    store.getState().hydrateEditorSession(folderSession([null]))

    expect(store.getState().openFiles.map((file) => file.runtimeEnvironmentId)).toEqual([
      STALE_TAB_RUNTIME_ENV_ID
    ])
  })

  it('refuses to heal an unstamped folder row, workspace focus notwithstanding', () => {
    const store = prepareFolderStore()
    store.getState().hydrateEditorSession(folderSession([STALE_TAB_RUNTIME_ENV_ID, null]))

    expect(store.getState().openFiles.map((file) => file.runtimeEnvironmentId)).toEqual([
      STALE_TAB_RUNTIME_ENV_ID,
      null
    ])
  })

  it('reads no owner out of the focused runtime environment', () => {
    const focusedRuntimeState: WorktreeOperationRouteState = {
      folderWorkspaces: [
        { id: FOLDER_WORKSPACE_ID, projectGroupId: 'project-group-1', connectionId: null }
      ],
      projectGroups: [{ id: 'project-group-1', connectionId: null }],
      activeWorktreeId: FOLDER_WORKSPACE_KEY,
      activeWorkspaceExecutionHostId: RUNTIME_HOST_ID,
      settings: { activeRuntimeEnvironmentId: STALE_TAB_RUNTIME_ENV_ID },
      runtimeEnvironments: [{ id: STALE_TAB_RUNTIME_ENV_ID }]
    }

    // The app's own resolver answers `runtime:…` here; an owner rewrite needs more than focus.
    expect(resolveWorktreeOperationRouteResult(focusedRuntimeState, FOLDER_WORKSPACE_KEY)).toEqual({
      kind: 'resolved',
      route: { executionHostId: RUNTIME_HOST_ID, runtimeEnvironmentId: STALE_TAB_RUNTIME_ENV_ID }
    })
    expect(resolveHealableWorktreeOwnerRoute(focusedRuntimeState, FOLDER_WORKSPACE_KEY)).toBeNull()
  })
})
