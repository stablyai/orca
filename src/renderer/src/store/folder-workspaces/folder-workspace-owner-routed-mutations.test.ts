import { beforeEach, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { createTestStore } from '../testing/app-store-test-fixture'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { showDeleteWorktreeFailureToast } from '@/components/sidebar/workspace-actions/deletion/delete-worktree-failure-toast'
import { deleteFolderWorkspaceUnlessUnsaved } from '@/components/sidebar/workspace-actions/deletion/folder-workspace-delete'

vi.mock('@/components/sidebar/workspace-actions/deletion/delete-worktree-failure-toast', () => ({
  showDeleteWorktreeFailureToast: vi.fn()
}))

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
      projectGroups: {
        checkHooks: vi.fn(async () => ({
          status: 'ok',
          hasHooks: false,
          hooks: null,
          mayNeedUpdate: false,
          setupRunPolicy: 'ask',
          setupConfig: null
        }))
      },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

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

it('rechecks unsaved editor text before the Archive failure toast waives removal', async () => {
  const store = createTestStore()
  const folder = makeFolderWorkspace({ executionHostId: 'local' })
  const workspaceKey = folderWorkspaceKey(folder.id)
  store.setState({
    projectGroups: [projectGroup],
    folderWorkspaces: [folder],
    shutdownWorktreeBrowsers: vi.fn(async () => {}),
    deleteManagedBrowserSessionProfile: vi.fn(),
    purgeWorktreeTerminalState: vi.fn()
  })
  vi.mocked(showDeleteWorktreeFailureToast).mockClear()
  folderWorkspacesDelete
    .mockRejectedValueOnce(new Error('Archive hook failed for worktree: /workspace/platform'))
    .mockResolvedValueOnce(true)
  await expect(
    deleteFolderWorkspaceUnlessUnsaved(store.getState, folder.id, 'local')
  ).resolves.toBe(false)
  expect(showDeleteWorktreeFailureToast).toHaveBeenCalledTimes(1)
  const retry = vi.mocked(showDeleteWorktreeFailureToast).mock.calls[0][0].onDeleteAnyway
  expect(retry).toBeTypeOf('function')
  store.setState({
    openFiles: [
      {
        id: 'dirty-file',
        filePath: '/workspace/platform/file.txt',
        relativePath: 'file.txt',
        worktreeId: workspaceKey,
        language: 'plaintext',
        isDirty: true,
        mode: 'edit'
      }
    ]
  })
  await retry?.()
  expect(folderWorkspacesDelete).toHaveBeenCalledTimes(1)
  expect(store.getState().folderWorkspaces.map((entry) => entry.id)).toEqual(['folder-workspace-1'])
  store.setState({ openFiles: [], editorDrafts: {} })
  await retry?.()
  expect(folderWorkspacesDelete).toHaveBeenLastCalledWith({
    folderWorkspaceId: 'folder-workspace-1',
    runHooks: false,
    allowFailedArchiveHook: true
  })
  expect(store.getState().folderWorkspaces).toEqual([])
})
