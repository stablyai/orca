import { beforeEach, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { createTestStore } from '../testing/app-store-test-fixture'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { showDeleteWorktreeFailureToast } from '@/components/sidebar/workspace-actions/deletion/delete-worktree-failure-toast'
import { deleteFolderWorkspaceUnlessUnsaved } from '@/components/sidebar/workspace-actions/deletion/folder-workspace-delete'

vi.mock('@/components/sidebar/workspace-actions/deletion/delete-worktree-failure-toast', () => ({
  showDeleteWorktreeFailureToast: vi.fn()
}))

const folderWorkspacesDelete = vi.fn()

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
  folderWorkspacesDelete.mockReset()
  vi.stubGlobal('window', {
    api: {
      folderWorkspaces: {
        delete: folderWorkspacesDelete
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
      }
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
  store.setState({
    projectGroups: [projectGroup],
    folderWorkspaces: [...folders, twin, live],
    shutdownWorktreeBrowsers: async () => {},
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
  await store.getState().deleteFolderWorkspace(folders[0].id, { executionHostId: 'local' })
  expect(attempts[0].draft?.text).toBe('task 0')
  expect(nativeChatPendingAttachmentSnapshot(scope(folders[0].id))).toHaveLength(1)
  folderWorkspacesDelete.mockResolvedValue(true)
  for (const [i, folder] of folders.entries()) {
    await store.getState().deleteFolderWorkspace(folder.id, { executionHostId: 'local' })
    expect(attempts[i].draft).toBeUndefined()
  }
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
    .mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'folderWorkspaces:delete': WorktreeArchiveHookFailedError: Archive hook failed for worktree: /workspace/platform"
      )
    )
    .mockResolvedValueOnce(true)
  await deleteFolderWorkspaceUnlessUnsaved(store.getState, folder.id, 'local')
  const failure = vi.mocked(showDeleteWorktreeFailureToast).mock.calls[0][0]
  const retry = failure.onDeleteAnyway
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
  expect(store.getState().folderWorkspaces.map((entry) => entry.id)).toEqual(['folder-workspace-1'])
  store.setState({ openFiles: [], editorDrafts: {} })
  await retry?.()
  expect(store.getState().folderWorkspaces).toEqual([])
})
