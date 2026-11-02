import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { RuntimeMobileSessionFileTab } from '../../../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { buildWorkspaceSessionPayload } from '../../lib/workspace-session'
import { createMirroredEditorFileResolver } from '../../runtime/web-session-tabs-sync/mirrored-editor-file-identity'
import { buildHydratedEditorSessionState } from './editor/actions/hydrated-editor-session-state'
import { buildOwnedEditorFileId } from './editor/file-ids/editor-file-ids'
import type { OpenFile } from './editor/types/open-file'
import { createStoreSessionMockApi } from './store-session-test-harness'
import { createTestStore, makeWorktree } from './store-test-helpers'
import { drawTabsFromMain } from './tabs-drawn-from-main.test-fixture'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

createStoreSessionMockApi()

const ENV = 'env-1'
const WT_A = 'repo-1::/srv/a'
const WT_B = 'repo-1::/srv/b'
const FILE_PATH = '/srv/shared/notes.ts'

function prepareStore() {
  const store = createTestStore()
  store.setState({
    repos: [{ id: 'repo-1', path: '/srv/a', displayName: 'Repo', badgeColor: '#000', addedAt: 0 }],
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({ id: WT_A, repoId: 'repo-1', path: '/srv/a' }),
        makeWorktree({ id: WT_B, repoId: 'repo-1', path: '/srv/b' })
      ]
    },
    activeWorktreeId: WT_A
  })
  return store
}

type TestStore = ReturnType<typeof prepareStore>

function openServerFile(store: TestStore, worktreeId: string, runtimeEnvironmentId?: string) {
  return store.getState().openFile({
    filePath: FILE_PATH,
    relativePath: 'notes.ts',
    worktreeId,
    language: 'typescript',
    mode: 'edit',
    ...(runtimeEnvironmentId ? { runtimeEnvironmentId } : {})
  })
}

function restart(store: TestStore, session = buildWorkspaceSessionPayload(store.getState())) {
  const restarted = prepareStore()
  restarted.getState().hydrateTabsSession(session)
  restarted.getState().hydrateEditorSession(session)
  return restarted.getState()
}

function editorEntityIds(state: ReturnType<TestStore['getState']>, worktreeId: string) {
  return (state.unifiedTabsByWorktree[worktreeId] ?? []).map((tab) => tab.entityId)
}

describe('a server file keeps its id across a restart', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('names a server file by its owned id on first open, and a restart keeps that id', async () => {
    const store = prepareStore()
    const main = await drawTabsFromMain(store)
    const fileId = openServerFile(store, WT_A, ENV)
    await main.settle()
    main.close()
    expect(fileId).toBe(buildOwnedEditorFileId(FILE_PATH, WT_A, ENV))
    const tabIds = (store.getState().unifiedTabsByWorktree[WT_A] ?? []).map((tab) => tab.id)

    const session = buildWorkspaceSessionPayload(store.getState())
    const restored = buildHydratedEditorSessionState(session, new Set([WT_A, WT_B]), WT_A)
    expect(restored.state.openFiles.map((file) => file.id)).toEqual([fileId])
    expect(restored.editorFileIdMigrationsByWorktree[WT_A]?.has(fileId)).not.toBe(true)

    const restarted = restart(store, session)
    expect(restarted.openFiles.map((file) => file.id)).toEqual([fileId])
    expect(editorEntityIds(restarted, WT_A)).toEqual([fileId])
    expect((restarted.unifiedTabsByWorktree[WT_A] ?? []).map((tab) => tab.id)).toEqual(tabIds)
    expect(restarted.activeFileIdByWorktree[WT_A]).toBe(fileId)
  })

  it('names a file the live mirror opens the way a restart restores it', () => {
    const hostTab: RuntimeMobileSessionFileTab = {
      type: 'file',
      id: 'host-tab-1',
      title: 'notes.ts',
      filePath: FILE_PATH,
      relativePath: 'notes.ts',
      language: 'typescript',
      isDirty: false,
      isActive: true
    }
    const { fileId } = createMirroredEditorFileResolver([], WT_A, ENV)(hostTab, null)
    expect(fileId).toBe(buildOwnedEditorFileId(FILE_PATH, WT_A, ENV))

    const mirrored: OpenFile = {
      id: fileId,
      filePath: FILE_PATH,
      relativePath: 'notes.ts',
      worktreeId: WT_A,
      language: 'typescript',
      isDirty: false,
      runtimeEnvironmentId: ENV,
      mode: 'edit',
      mirroredFromRuntimeSession: true
    }
    const session = buildWorkspaceSessionPayload({
      ...prepareStore().getState(),
      openFiles: [mirrored]
    })
    const restored = buildHydratedEditorSessionState(session, new Set([WT_A]), WT_A)
    expect(restored.state.openFiles.map((file) => file.id)).toEqual([fileId])
    expect(restored.editorFileIdMigrationsByWorktree[WT_A]?.has(fileId)).not.toBe(true)
  })

  it('keeps an unsaved draft of a server file through a restart', () => {
    const store = prepareStore()
    const fileId = openServerFile(store, WT_A, ENV)
    store.getState().setEditorDraft(fileId, 'unsaved edit')
    store.getState().markFileDirty(fileId, true)

    const restarted = restart(store)
    expect(restarted.editorDrafts[fileId]).toBe('unsaved edit')
    expect(restarted.openFiles.find((file) => file.id === fileId)?.isDirty).toBe(true)
  })

  it('still names a local file by its path, also after a server file with the same path', () => {
    const store = prepareStore()
    const serverId = openServerFile(store, WT_A, ENV)
    const localId = openServerFile(store, WT_A)
    expect(localId).toBe(FILE_PATH)
    expect(serverId).not.toBe(localId)

    const restarted = restart(store)
    expect(restarted.openFiles.map((file) => file.id).sort()).toEqual([localId, serverId].sort())
  })

  it('keeps the same server path in two workspaces as two tabs of one record, through a restart', async () => {
    const store = prepareStore()
    const main = await drawTabsFromMain(store)
    const idA = openServerFile(store, WT_A, ENV)
    const idB = openServerFile(store, WT_B, ENV)
    await main.settle()
    main.close()
    expect(idA).toBe(buildOwnedEditorFileId(FILE_PATH, WT_A, ENV))
    expect(idB).toBe(buildOwnedEditorFileId(FILE_PATH, WT_B, ENV))
    store.getState().setEditorDraft(idA, 'draft a')
    store.getState().markFileDirty(idA, true)
    store.getState().setEditorDraft(idB, 'draft b')
    store.getState().markFileDirty(idB, true)

    const restarted = restart(store)
    expect(editorEntityIds(restarted, WT_A)).toEqual([idA])
    expect(editorEntityIds(restarted, WT_B)).toEqual([idB])
    expect(restarted.editorDrafts[idA]).toBe('draft b')
    expect(restarted.editorDrafts[idB]).toBe('draft b')
  })

  it('still moves an older session that saved a server file under its path', () => {
    const ownedId = buildOwnedEditorFileId(FILE_PATH, WT_A, ENV)
    const session: WorkspaceSessionState = {
      activeRepoId: 'repo-1',
      activeWorktreeId: WT_A,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        [WT_A]: [
          {
            filePath: FILE_PATH,
            relativePath: 'notes.ts',
            worktreeId: WT_A,
            language: 'typescript',
            runtimeEnvironmentId: ENV,
            dirtyDraftContent: 'old draft'
          }
        ]
      },
      activeFileIdByWorktree: { [WT_A]: FILE_PATH },
      activeTabTypeByWorktree: { [WT_A]: 'editor' },
      unifiedTabs: {
        [WT_A]: [
          {
            id: 'tab-1',
            entityId: FILE_PATH,
            groupId: 'group-1',
            worktreeId: WT_A,
            contentType: 'editor',
            label: 'notes.ts',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        [WT_A]: [{ id: 'group-1', worktreeId: WT_A, activeTabId: 'tab-1', tabOrder: ['tab-1'] }]
      },
      activeGroupIdByWorktree: { [WT_A]: 'group-1' }
    }

    const restarted = restart(prepareStore(), session)
    expect(restarted.openFiles.map((file) => file.id)).toEqual([ownedId])
    expect(editorEntityIds(restarted, WT_A)).toEqual([ownedId])
    expect(restarted.activeFileIdByWorktree[WT_A]).toBe(ownedId)
    expect(restarted.editorDrafts[ownedId]).toBe('old draft')
  })
})
