import { it, vi, expect, afterEach } from 'vitest'
import { createTestStore } from '../testing/app-store-test-fixture'
import * as drafts from '@/components/native-chat/drafts/native-chat-draft-reset'
import * as draftsOwner1 from '@/components/native-chat/drafts/native-chat-launch-draft-source'
import * as draftsOwner2 from '@/components/native-chat/drafts/native-chat-composer-draft-store'

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
  const from = draftsOwner1.nativeChatLaunchPromptDraftScopeKey('folder:uuid', 'codex', 'ssh:old')
  const paired = draftsOwner1.nativeChatLaunchPromptDraftScopeKey(
    'folder:uuid',
    'codex',
    'runtime:other'
  )
  draftsOwner2.updateNativeChatComposerDraft(from, { text: 'unsent folder' }, 'immediate')
  draftsOwner2.updateNativeChatComposerDraft(paired, { text: 'paired origin' }, 'immediate')
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
  const to = draftsOwner1.nativeChatLaunchPromptDraftScopeKey('folder:uuid', 'codex', 'ssh:new')
  expect(draftsOwner2.readNativeChatComposerDraft(to)).toBe(
    draftsOwner2.readNativeChatComposerDraft(from)
  )
  expect(draftsOwner2.readNativeChatComposerDraft(to).text).toBe('unsent folder')
  // Operation origin/UUID still selects this source if its execution projection lags.
  store.setState({
    folderWorkspaces: [{ ...folder, connectionId: 'old', executionHostId: 'ssh:old' }]
  })
  expect(await store.getState().deleteFolderWorkspace('uuid', { executionHostId: 'ssh:old' })).toBe(
    true
  )
  expect(draftsOwner1.launchDraftSource(from)?.executionHostId).toBe('ssh:new')
  expect(draftsOwner2.readNativeChatComposerDraft(paired).text).toBe('paired origin')
  vi.unstubAllGlobals()
  drafts.clearNativeChatComposerDraftsForTests()
})
