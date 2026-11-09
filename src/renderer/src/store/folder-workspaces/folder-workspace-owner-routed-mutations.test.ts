import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { WORKTREE_LINKED_ITEMS_RUNTIME_CAPABILITY } from '../../../../shared/workspace-attachments/workspace-attachment-capabilities'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { createTestStore } from '../testing/app-store-test-fixture'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'

const folderWorkspacesUpdate = vi.fn()
const folderWorkspacesDelete = vi.fn()
const folderWorkspacesList = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

const projectGroup: ProjectGroup = {
  id: 'group-1',
  name: 'Platform',
  parentPath: '/workspace/platform',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-workspace-1',
    projectGroupId: projectGroup.id,
    name: 'Platform folder',
    folderPath: '/workspace/platform',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  folderWorkspacesUpdate.mockReset()
  folderWorkspacesDelete.mockReset()
  folderWorkspacesList.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      folderWorkspaces: {
        update: folderWorkspacesUpdate,
        delete: folderWorkspacesDelete,
        list: folderWorkspacesList
      },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('folder workspace owner-routed mutations', () => {
  it('updates inherited folder metadata and batches on the qualified physical row', async () => {
    const inherited = makeFolderWorkspace({ projectGroupId: 'inherited', folderPath: '/remote' })
    const local = makeFolderWorkspace({ executionHostId: 'local', folderPath: '/local' })
    const store = createTestStore()
    store.setState({
      repos: [],
      activeWorktreeId: folderWorkspaceKey(inherited.id),
      activeWorkspaceExecutionHostId: 'runtime:env-owner',
      projectGroups: [
        {
          ...projectGroup,
          id: 'inherited',
          executionHostId: 'runtime:env-owner',
          connectionId: 'box'
        }
      ],
      folderWorkspaces: [local, inherited]
    })
    let remote = inherited
    runtimeEnvironmentCall.mockImplementation(async (args: RuntimeEnvironmentCallRequest) => {
      const updates = args.params?.updates
      if (!updates || typeof updates !== 'object') {
        throw new Error('Missing update payload')
      }
      remote = { ...remote, ...updates }
      return { id: 'write', ok: true, result: { folderWorkspace: remote } }
    })
    await expect(
      store
        .getState()
        .updateWorktreeMeta(
          folderWorkspaceKey(inherited.id),
          { comment: 'kept on server' },
          { executionHostId: 'runtime:env-owner' }
        )
    ).resolves.toEqual({ ok: true })
    await store
      .getState()
      .updateWorktreesMeta([
        { worktreeId: folderWorkspaceKey(inherited.id), updates: { manualOrder: 9 } }
      ])
    expect(
      runtimeEnvironmentCall.mock.calls.filter(([args]) => args.method === 'folderWorkspace.update')
        .length
    ).toBe(2)
    expect(store.getState().folderWorkspaces.find((row) => row.folderPath === '/local')).toBe(local)
    expect(
      store.getState().folderWorkspaces.find((row) => row.folderPath === '/remote')
    ).toMatchObject({ comment: 'kept on server', manualOrder: 9 })
  })

  it('reports failure when the host drops an attachment collection', async () => {
    const folderWorkspace = makeFolderWorkspace()
    folderWorkspacesUpdate.mockResolvedValue(folderWorkspace)
    folderWorkspacesList.mockResolvedValue([folderWorkspace])
    const store = createTestStore()
    store.setState({
      projectGroups: [{ ...projectGroup, executionHostId: 'local' }],
      folderWorkspaces: [folderWorkspace]
    })
    const result = await store.getState().updateFolderWorkspace(folderWorkspace.id, {
      linkedItems: [{ provider: 'linear', type: 'issue', number: 0, identifier: 'ENG-42' }]
    })
    expect(result).toBe(false)
    expect(store.getState().folderWorkspaces[0]?.linkedItems).toBeUndefined()
  })

  it('ignores an older response after the same field changes again', async () => {
    const folderWorkspace = makeFolderWorkspace()
    let resolveOlder!: (workspace: FolderWorkspace) => void
    let resolveNewer!: (workspace: FolderWorkspace) => void
    folderWorkspacesUpdate
      .mockImplementationOnce(
        () =>
          new Promise<FolderWorkspace>((resolve) => {
            resolveOlder = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<FolderWorkspace>((resolve) => {
            resolveNewer = resolve
          })
      )
    const store = createTestStore()
    store.setState({
      projectGroups: [{ ...projectGroup, executionHostId: 'local' }],
      folderWorkspaces: [folderWorkspace]
    })

    const olderUpdate = store
      .getState()
      .updateFolderWorkspace(folderWorkspace.id, { isUnread: true })
    const newerUpdate = store
      .getState()
      .updateFolderWorkspace(folderWorkspace.id, { isUnread: false })
    resolveNewer({ ...folderWorkspace, isUnread: false, updatedAt: 3 })
    await newerUpdate
    resolveOlder({ ...folderWorkspace, isUnread: true, updatedAt: 2 })
    await olderUpdate

    expect(store.getState().folderWorkspaces[0]?.isUnread).toBe(false)
    expect(store.getState().folderWorkspaces[0]?.updatedAt).toBe(3)
  })

  it('does not share update generations between store instances', async () => {
    const folderWorkspace = makeFolderWorkspace()
    folderWorkspacesUpdate
      .mockResolvedValueOnce({ ...folderWorkspace, comment: 'First store' })
      .mockResolvedValueOnce({ ...folderWorkspace, comment: 'Second store' })
    const firstStore = createTestStore()
    const secondStore = createTestStore()
    for (const store of [firstStore, secondStore]) {
      store.setState({
        projectGroups: [{ ...projectGroup, executionHostId: 'local' }],
        folderWorkspaces: [folderWorkspace]
      })
    }

    await Promise.all([
      firstStore.getState().updateFolderWorkspace(folderWorkspace.id, { comment: 'First store' }),
      secondStore.getState().updateFolderWorkspace(folderWorkspace.id, { comment: 'Second store' })
    ])

    expect(firstStore.getState().folderWorkspaces[0]?.comment).toBe('First store')
    expect(secondStore.getState().folderWorkspaces[0]?.comment).toBe('Second store')
  })

  it('does not apply an update response over a newer catalog refresh', async () => {
    const folderWorkspace = makeFolderWorkspace()
    let resolveUpdate!: (workspace: FolderWorkspace) => void
    folderWorkspacesUpdate.mockImplementation(
      () =>
        new Promise<FolderWorkspace>((resolve) => {
          resolveUpdate = resolve
        })
    )
    folderWorkspacesList.mockResolvedValue([{ ...folderWorkspace, isUnread: false, updatedAt: 3 }])
    const store = createTestStore()
    store.setState({
      projectGroups: [{ ...projectGroup, executionHostId: 'local' }],
      folderWorkspaces: [folderWorkspace]
    })

    const pendingUpdate = store
      .getState()
      .updateFolderWorkspace(folderWorkspace.id, { isUnread: true })
    await store.getState().fetchFolderWorkspaces(catalogOwner(store))
    resolveUpdate({ ...folderWorkspace, isUnread: true, updatedAt: 2 })
    await pendingUpdate

    expect(store.getState().folderWorkspaces[0]?.isUnread).toBe(false)
    expect(store.getState().folderWorkspaces[0]?.updatedAt).toBe(3)
  })

  it('does not fence a runtime update when the local same-ID catalog refreshes', async () => {
    const localWorkspace = makeFolderWorkspace({ updatedAt: 3 })
    const runtimeWorkspace = {
      ...makeFolderWorkspace(),
      executionHostId: 'runtime:env-owner' as const
    }
    let resolveRuntimeUpdate!: (response: {
      id: string
      ok: true
      result: { folderWorkspace: FolderWorkspace }
      _meta: { runtimeId: string }
    }) => void
    runtimeEnvironmentCall.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRuntimeUpdate = resolve
        })
    )
    folderWorkspacesList.mockResolvedValue([localWorkspace])
    const store = createTestStore()
    store.setState({
      projectGroups: [{ ...projectGroup, executionHostId: 'local' }],
      folderWorkspaces: [localWorkspace, runtimeWorkspace]
    })

    const pendingUpdate = store
      .getState()
      .updateFolderWorkspace(
        runtimeWorkspace.id,
        { isUnread: true },
        { executionHostId: 'runtime:env-owner' }
      )
    await vi.waitFor(() => expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1))
    await store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: null })
    resolveRuntimeUpdate({
      id: 'rpc-update-folder',
      ok: true,
      result: {
        folderWorkspace: { ...runtimeWorkspace, isUnread: true, updatedAt: 2 }
      },
      _meta: { runtimeId: 'runtime-owner' }
    })
    await pendingUpdate

    expect(store.getState().folderWorkspaces).toEqual([
      { ...localWorkspace, executionHostId: 'local' },
      { ...runtimeWorkspace, isUnread: true, updatedAt: 2 }
    ])
  })

  it('reconciles optimistic fields when persistence fails', async () => {
    const persisted = makeFolderWorkspace({ isUnread: true, updatedAt: 2 })
    folderWorkspacesUpdate.mockResolvedValue(null)
    folderWorkspacesList.mockResolvedValue([persisted])
    const store = createTestStore()
    store.setState({
      projectGroups: [{ ...projectGroup, executionHostId: 'local' }],
      folderWorkspaces: [{ ...persisted, isUnread: false }]
    })

    await expect(
      store.getState().updateFolderWorkspace(persisted.id, { isUnread: false })
    ).resolves.toBe(false)

    expect(folderWorkspacesList).toHaveBeenCalledTimes(1)
    expect(store.getState().folderWorkspaces[0]?.isUnread).toBe(true)
  })

  it('deletes only the selected owner row when workspace IDs collide', async () => {
    const localFolder = makeFolderWorkspace({ executionHostId: 'local' })
    const runtimeFolder = makeFolderWorkspace({
      name: 'Runtime collision',
      folderPath: '/runtime/platform',
      executionHostId: 'runtime:env-owner'
    })
    folderWorkspacesDelete.mockResolvedValue(true)
    const store = createTestStore()
    const shutdownWorktreeBrowsers = vi.fn().mockResolvedValue(undefined)
    store.setState({
      settings: { activeRuntimeEnvironmentId: null } as never,
      activeWorktreeId: `folder:${localFolder.id}`,
      activeWorkspaceExecutionHostId: 'local',
      projectGroups: [
        { ...projectGroup, executionHostId: 'local' },
        { ...projectGroup, executionHostId: 'runtime:env-owner' }
      ],
      folderWorkspaces: [localFolder, runtimeFolder],
      shutdownWorktreeBrowsers
    })

    await expect(store.getState().deleteFolderWorkspace(localFolder.id)).resolves.toBe(true)

    expect(folderWorkspacesDelete).toHaveBeenCalledWith({
      folderWorkspaceId: localFolder.id
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    // Delete is owner-scoped: the sibling host's row keeps the bare ID alive.
    expect(store.getState().folderWorkspaces).toEqual([runtimeFolder])
    expect(shutdownWorktreeBrowsers).not.toHaveBeenCalled()
  })

  it('deletes only the host-qualified folder when ids collide', async () => {
    const localFolder = makeFolderWorkspace({ executionHostId: 'local' })
    const runtimeFolder = makeFolderWorkspace({ executionHostId: 'runtime:env-owner' })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-delete-folder',
      ok: true,
      result: { deleted: true },
      _meta: { runtimeId: 'runtime-owner' }
    })
    const store = createTestStore()
    store.setState({
      activeWorktreeId: `folder:${runtimeFolder.id}`,
      activeWorkspaceExecutionHostId: 'runtime:env-owner',
      settings: { activeRuntimeEnvironmentId: 'env-owner' } as never,
      projectGroups: [{ ...projectGroup, executionHostId: 'local' }],
      folderWorkspaces: [localFolder, runtimeFolder]
    })

    await expect(
      store
        .getState()
        .deleteFolderWorkspace(runtimeFolder.id, { executionHostId: 'runtime:env-owner' })
    ).resolves.toBe(true)

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-owner',
      method: 'folderWorkspace.delete',
      params: { folderWorkspaceId: runtimeFolder.id },
      timeoutMs: 15_000
    })
    expect(store.getState().folderWorkspaces).toEqual([localFolder])
  })
  it('refuses collection creation before an old runtime strips attachments', async () => {
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      const status = createCompatibleRuntimeStatusResponseIfNeeded(args)
      if (status?.ok) {
        status.result.capabilities = (status.result.capabilities ?? []).filter(
          (capability) => capability !== WORKTREE_LINKED_ITEMS_RUNTIME_CAPABILITY
        )
        return status
      }
      return runtimeEnvironmentCall(args)
    })
    const store = createTestStore()
    store.setState({
      settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'env-old' })
    })
    await expect(
      store
        .getState()
        .createFolderWorkspace(
          { projectGroupId: projectGroup.id, linkedItems: [] },
          { runtimeEnvironmentId: 'env-old' }
        )
    ).rejects.toThrow('Update the remote runtime')
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })
})

// The catalog these tests read is the one the focused host would have shown.
function catalogOwner(store: {
  getState: () => { settings: { activeRuntimeEnvironmentId?: string | null } | null }
}): { runtimeEnvironmentId: string | null } {
  return { runtimeEnvironmentId: store.getState().settings?.activeRuntimeEnvironmentId ?? null }
}

import * as composerDrafts from '@/components/native-chat/drafts/native-chat-draft-reset'
import * as composerDraftsOwner1 from '@/components/native-chat/drafts/native-chat-launch-draft-source'
import * as composerDraftsOwner2 from '@/components/native-chat/drafts/native-chat-composer-draft-store'
import * as composerDraftsOwner3 from '@/components/native-chat/drafts/native-chat-composer-draft-memory'
import {
  addNativeChatPendingAttachment,
  nativeChatPendingAttachmentSnapshot,
  settleNativeChatPendingAttachment,
  clearNativeChatPendingAttachmentsForTests
} from '@/components/native-chat/attachments/chips/native-chat-pending-attachment-cache'

it('retires removed folder launch submissions while preserving physical twins and new lifetimes', async () => {
  composerDrafts.clearNativeChatComposerDraftsForTests()
  clearNativeChatPendingAttachmentsForTests()
  const store = createTestStore()
  const folders = Array.from({ length: 2 }, (_, i) =>
    makeFolderWorkspace({ id: `retired-${i}`, executionHostId: 'local' })
  )
  const twin = { ...folders[0], executionHostId: 'runtime:env-owner' as const }
  const live = makeFolderWorkspace({ id: 'live', executionHostId: 'local' })
  const shutdown = vi.fn(async () => {})
  store.setState({
    projectGroups: [projectGroup],
    folderWorkspaces: [...folders, twin, live],
    shutdownWorktreeBrowsers: shutdown,
    deleteManagedBrowserSessionProfile: vi.fn(),
    purgeWorktreeTerminalState: vi.fn()
  })
  const scope = (id: string, host = 'local') =>
    composerDraftsOwner1.nativeChatLaunchPromptDraftScopeKey(folderWorkspaceKey(id), 'claude', host)
  const liveScopes = [scope('live'), scope(twin.id, 'runtime:env-owner')]
  for (const key of liveScopes) {
    composerDraftsOwner2.updateNativeChatComposerDraft(key, { text: 'keep' }, 'immediate')
  }
  const attempts = folders.map((folder, i) => {
    const key = scope(folder.id)
    composerDraftsOwner2.updateNativeChatComposerDraft(key, { text: `task ${i}` }, 'immediate')
    addNativeChatPendingAttachment(key, { id: key, path: '', pending: true })
    const submission = composerDraftsOwner3.captureNativeChatComposerSubmission(key)
    if (i % 2 === 0) {
      composerDraftsOwner2.updateNativeChatComposerDraft(key, { text: '' }, 'immediate')
    }
    return submission
  })
  folderWorkspacesDelete.mockResolvedValue(false)
  expect(
    await store.getState().deleteFolderWorkspace(folders[0].id, { executionHostId: 'local' })
  ).toBe(false)
  expect(attempts[0].draft?.text).toBe('task 0')
  expect(nativeChatPendingAttachmentSnapshot(scope(folders[0].id))).toHaveLength(1)
  folderWorkspacesDelete.mockResolvedValue(true)
  for (const [i, folder] of folders.entries()) {
    expect(
      await store.getState().deleteFolderWorkspace(folder.id, { executionHostId: 'local' })
    ).toBe(true)
    expect(attempts[i].draft).toBeUndefined()
    if (i === 0) {
      expect(shutdown).not.toHaveBeenCalled()
    }
  }
  expect(shutdown).toHaveBeenCalledTimes(1)
  for (const key of liveScopes) {
    expect(composerDraftsOwner2.readNativeChatComposerDraft(key).text).toBe('keep')
  }
  store.setState((s) => ({ folderWorkspaces: [...s.folderWorkspaces, folders[0]] }))
  const recreated = scope(folders[0].id)
  composerDraftsOwner2.updateNativeChatComposerDraft(
    recreated,
    { text: 'new lifetime' },
    'immediate'
  )
  folders.forEach((folder, i) => {
    const key = scope(folder.id)
    // A same-ID survivor skips ordinary cleanup as on main, so only that folder's chip stays.
    expect(nativeChatPendingAttachmentSnapshot(key)).toHaveLength(i === 0 ? 1 : 0)
    if (i > 0) {
      expect(settleNativeChatPendingAttachment(key, key, '/late.png')).toBe(false)
    }
    composerDraftsOwner2.finishNativeChatComposerSubmission(key, attempts[i], true)
  })
  expect(composerDraftsOwner2.readNativeChatComposerDraft(recreated).text).toBe('new lifetime')
  composerDrafts.clearNativeChatComposerDraftsForTests()
  clearNativeChatPendingAttachmentsForTests()
})
