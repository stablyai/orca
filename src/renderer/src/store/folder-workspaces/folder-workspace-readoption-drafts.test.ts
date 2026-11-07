import { it, vi, expect, afterEach } from 'vitest'
import { createTestStore } from '../slices/store-test-helpers'
import * as drafts from '@/components/native-chat/native-chat-composer-draft-store'
import * as sources from '@/components/native-chat/native-chat-launch-draft-source'

afterEach(() => vi.restoreAllMocks())

it('folder-only SSH target reassignment publishes origin-qualified UUID continuity without repo descriptors', async () => {
  drafts.clearNativeChatComposerDraftsForTests()
  const folder = {
    id: 'uuid',
    projectGroupId: 'group',
    folderPath: '/folder',
    name: 'Folder',
    connectionId: 'old',
    executionHostId: 'ssh:old' as const,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
  const from = drafts.nativeChatLaunchPromptDraftScopeKey('folder:uuid', 'codex', 'ssh:old')
  const paired = drafts.nativeChatLaunchPromptDraftScopeKey('folder:uuid', 'codex', 'runtime:other')
  drafts.updateNativeChatComposerDraft(from, { text: 'unsent folder' }, 'immediate')
  drafts.updateNativeChatComposerDraft(paired, { text: 'paired origin' }, 'immediate')
  // The main process's target reassignment rewrites the folder's connection and host in place.
  const reassigned = { ...folder, connectionId: 'new', executionHostId: 'ssh:new' as const }
  const store = createTestStore()
  store.setState({ folderWorkspaces: [reassigned] })
  vi.stubGlobal('window', {
    api: {
      folderWorkspaces: {
        list: vi.fn().mockResolvedValue([reassigned]),
        delete: vi.fn().mockResolvedValue(true)
      }
    }
  })
  await store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: null })
  const to = drafts.nativeChatLaunchPromptDraftScopeKey('folder:uuid', 'codex', 'ssh:new')
  expect(drafts.readNativeChatComposerDraft(to)).toBe(drafts.readNativeChatComposerDraft(from))
  expect(drafts.readNativeChatComposerDraft(to).text).toBe('unsent folder')
  // Operation origin/UUID still selects this source if its execution projection lags.
  store.setState({
    folderWorkspaces: [{ ...folder, connectionId: 'old', executionHostId: 'ssh:old' }]
  })
  expect(await store.getState().deleteFolderWorkspace('uuid', { executionHostId: 'ssh:old' })).toBe(
    true
  )
  expect(sources.launchDraftSource(from)?.executionHostId).toBe('ssh:new')
  expect(drafts.readNativeChatComposerDraft(paired).text).toBe('paired origin')
  vi.unstubAllGlobals()
  drafts.clearNativeChatComposerDraftsForTests()
})
