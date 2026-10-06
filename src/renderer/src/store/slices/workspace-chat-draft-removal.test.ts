/**
 * A workspace's unsent chat drafts die only with a user's delete, by keys read before the host
 * round trip. The host announces a removal before it replies, and a listing purge that lands first
 * must not hide them; a purge that is not a user's delete must not erase them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const mockApi = {
  worktrees: { list: vi.fn(), remove: vi.fn(), updateMeta: vi.fn().mockResolvedValue({}) },
  repos: { remove: vi.fn() },
  folderWorkspaces: { delete: vi.fn() },
  pty: { kill: vi.fn() },
  runtimeEnvironments: { call: vi.fn().mockResolvedValue({ ok: true, result: {} }) }
}
// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: mockApi }

import {
  createTestStore,
  seedStore,
  makeWorktree,
  makeTab,
  makeTabGroup,
  makeUnifiedTab,
  TEST_REPO
} from './store-test-helpers'
import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  setNativeChatComposerDraftOwnerResolver,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from '@/components/native-chat/native-chat-composer-draft-store'
import { resolveNativeChatDraftOwner } from '@/lib/native-chat-draft-owner'

const WT1 = 'repo1::/path/wt1'
const WT2 = 'repo1::/path/wt2'
const CHAT = structuredAgentSessionDraftScopeKey('session-1')
const PANE = 'tab-wt1:leaf-a'
const OTHER = 'tab-wt2:leaf-a'

function seedWorkspace(store: ReturnType<typeof createTestStore>, workspaceId: string): void {
  const chat = makeUnifiedTab({
    id: 'chat-tab',
    entityId: 'session-1',
    contentType: 'agent-session',
    worktreeId: workspaceId,
    groupId: 'group-1'
  })
  seedStore(store, {
    tabsByWorktree: {
      [workspaceId]: [makeTab({ id: 'tab-wt1', worktreeId: workspaceId })],
      [WT2]: [makeTab({ id: 'tab-wt2', worktreeId: WT2 })]
    },
    unifiedTabsByWorktree: { [workspaceId]: [chat] },
    groupsByWorktree: {
      [workspaceId]: [
        makeTabGroup({
          id: 'group-1',
          worktreeId: workspaceId,
          activeTabId: chat.id,
          tabOrder: [chat.id]
        })
      ]
    }
  })
  updateNativeChatComposerDraft(CHAT, { text: 'chat' }, 'immediate')
  updateNativeChatComposerDraft(PANE, { text: 'pane' }, 'immediate')
  updateNativeChatComposerDraft(OTHER, { text: 'other' }, 'immediate')
}

function seedWorktree(store: ReturnType<typeof createTestStore>): void {
  seedStore(store, {
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id: WT1, repoId: 'repo1', path: '/path/wt1' }),
        makeWorktree({ id: WT2, repoId: 'repo1', path: '/path/wt2' })
      ]
    }
  })
  seedWorkspace(store, WT1)
}

function draftTexts(): string[] {
  return [CHAT, PANE, OTHER].map((key) => readNativeChatComposerDraft(key).text)
}

describe('workspace chat drafts on removal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.remove.mockResolvedValue(undefined)
    mockApi.repos.remove.mockResolvedValue(undefined)
    clearNativeChatComposerDraftsForTests()
  })

  it('removing a worktree deletes its drafts even when a listing purge lands mid-removal', async () => {
    const store = createTestStore()
    seedWorktree(store)
    mockApi.worktrees.remove.mockImplementation(async () => {
      store.getState().purgeWorktreeTerminalState([WT1])
    })

    const result = await store.getState().removeWorktree({ id: WT1, executionHostId: null }, true)

    expect(result).toEqual({ ok: true })
    expect(draftTexts()).toEqual(['', '', 'other'])
  })

  it('removing a worktree deletes the draft of a chat whose tab was closed earlier', async () => {
    const store = createTestStore()
    seedWorktree(store)
    setNativeChatComposerDraftOwnerResolver((scopeKey) =>
      resolveNativeChatDraftOwner(store.getState(), scopeKey)
    )
    const closed = structuredAgentSessionDraftScopeKey('session-closed')
    seedStore(store, {
      unifiedTabsByWorktree: {
        [WT1]: [
          ...(store.getState().unifiedTabsByWorktree[WT1] ?? []),
          makeUnifiedTab({
            id: 'closed-tab',
            entityId: 'session-closed',
            contentType: 'agent-session',
            worktreeId: WT1,
            groupId: 'group-1'
          })
        ]
      }
    })
    updateNativeChatComposerDraft(closed, { text: 'written, then its tab closed' }, 'immediate')
    store.getState().closeUnifiedTab('closed-tab')
    expect(readNativeChatComposerDraft(closed).text).toBe('written, then its tab closed')

    const result = await store.getState().removeWorktree({ id: WT1, executionHostId: null }, true)

    expect(result).toEqual({ ok: true })
    expect(readNativeChatComposerDraft(closed).text).toBe('')
    expect(draftTexts()).toEqual(['', '', 'other'])
  })

  it('a removal the host refuses keeps the drafts', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createTestStore()
    seedWorktree(store)
    mockApi.worktrees.remove.mockRejectedValue(new Error('Permission denied'))

    const result = await store.getState().removeWorktree({ id: WT1, executionHostId: null }, true)

    expect(result.ok).toBe(false)
    expect(draftTexts()).toEqual(['chat', 'pane', 'other'])
  })

  it('a listing purge alone keeps the drafts', () => {
    const store = createTestStore()
    seedWorktree(store)

    store.getState().purgeWorktreeTerminalState([WT1])

    expect(store.getState().unifiedTabsByWorktree[WT1]).toBeUndefined()
    expect(draftTexts()).toEqual(['chat', 'pane', 'other'])
  })

  it('re-pairing a server under the same id keeps the drafts of chats it restores', () => {
    const runtime = toRuntimeExecutionHostId('env-a')
    const environment = (pairingRevision: number): PublicKnownRuntimeEnvironment => ({
      id: 'env-a',
      name: 'Server',
      createdAt: 1,
      updatedAt: 1,
      pairingRevision,
      lastUsedAt: null,
      runtimeId: null,
      endpoints: [{ id: 'e', kind: 'websocket', label: 'Server', endpoint: 'ws://server' }],
      preferredEndpointId: 'e'
    })
    const store = createTestStore()
    seedStore(store, {
      runtimeEnvironments: [environment(1)],
      repos: [TEST_REPO, { ...TEST_REPO, id: 'repoA', path: '/repoA', executionHostId: runtime }],
      worktreesByRepo: {
        repoA: [makeWorktree({ id: WT1, repoId: 'repoA', path: '/path/wt1', hostId: runtime })]
      }
    })
    seedWorkspace(store, WT1)

    store.getState().setRuntimeEnvironments([environment(2)])

    expect(store.getState().unifiedTabsByWorktree[WT1]).toBeUndefined()
    expect(draftTexts()).toEqual(['chat', 'pane', 'other'])
  })

  it('removing a project deletes its worktrees’ drafts only', async () => {
    const store = createTestStore()
    seedStore(store, { repos: [{ ...TEST_REPO, id: 'repo1' }] })
    seedWorktree(store)
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: WT1, repoId: 'repo1', path: '/path/wt1' })],
        repo2: [makeWorktree({ id: WT2, repoId: 'repo2', path: '/path/wt2' })]
      }
    })

    await store.getState().removeProject('repo1')

    expect(draftTexts()).toEqual(['', '', 'other'])
  })

  it('deleting a folder workspace deletes its drafts', async () => {
    const folder: FolderWorkspace = {
      id: 'folder-1',
      projectGroupId: 'group-a',
      name: 'Folder',
      folderPath: '/workspace/folder',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 1,
      lastActivityAt: 0,
      createdAt: 1,
      updatedAt: 1
    }
    mockApi.folderWorkspaces.delete.mockResolvedValue(true)
    const store = createTestStore()
    store.setState({
      projectGroups: [
        {
          id: 'group-a',
          name: 'A',
          parentPath: '/workspace',
          parentGroupId: null,
          createdFrom: 'manual',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1,
          executionHostId: 'local'
        }
      ],
      folderWorkspaces: [folder]
    })
    seedWorkspace(store, folderWorkspaceKey(folder.id))

    await expect(store.getState().deleteFolderWorkspace(folder.id)).resolves.toBe(true)

    expect(draftTexts()).toEqual(['', '', 'other'])
  })
})
