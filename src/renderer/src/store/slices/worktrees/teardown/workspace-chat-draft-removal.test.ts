import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'

import '../../../../../../shared/execution-host'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))
vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const mockApi = {
  worktrees: { remove: vi.fn(), updateMeta: vi.fn().mockResolvedValue({}) },
  repos: { removeForHost: vi.fn() },
  folderWorkspaces: { delete: vi.fn() },
  pty: { kill: vi.fn() },
  runtimeEnvironments: { call: vi.fn().mockResolvedValue({ ok: true, result: {} }) }
}
// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: mockApi }

import { createTestStore, seedStore } from '../../../testing/app-store-test-fixture'
import { makeWorktree } from '../worktree.test-fixture'
import { makeTab } from '../../../terminals/testing/terminal-tab.test-fixture'
import { makeTabGroup, makeUnifiedTab } from '../../tabs/tab-group.test-fixture'
import { clearNativeChatComposerDraftsForTests } from '@/components/native-chat/drafts/native-chat-draft-reset'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '@/components/native-chat/drafts/native-chat-composer-draft-store'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/drafts/native-chat-draft-scope'
import { hydrateNativeChatComposerDrafts } from '@/components/native-chat/drafts/native-chat-composer-draft-load'
import { setNativeChatComposerDraftOwnerResolver } from '@/components/native-chat/drafts/native-chat-composer-draft-memory'
import {
  addNativeChatPendingAttachment,
  clearNativeChatPendingAttachmentsForTests,
  settleNativeChatPendingAttachment
} from '@/components/native-chat/attachments/chips/native-chat-pending-attachment-cache'
import { resolveNativeChatDraftOwner } from '@/components/native-chat/drafts/native-chat-draft-owner'

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

/** A pasted image still uploading in each scope; its chip's id is the scope's. */
function pasteStillUploading(...scopeKeys: string[]): void {
  for (const scopeKey of scopeKeys) {
    addNativeChatPendingAttachment(scopeKey, { id: scopeKey, path: '', pending: true })
  }
}

/** Each upload completes, as one does after its composer is gone; answers which scopes it reached. */
function uploadsComplete(...scopeKeys: string[]): string[] {
  return scopeKeys.filter((scopeKey) =>
    settleNativeChatPendingAttachment(scopeKey, scopeKey, `/store/${scopeKey}.png`)
  )
}

function draftImageCount(scopeKey: string): number {
  return readNativeChatComposerDraft(scopeKey).images.length
}

function trackDraftOwners(store: ReturnType<typeof createTestStore>): void {
  setNativeChatComposerDraftOwnerResolver((scopeKey) =>
    resolveNativeChatDraftOwner(store.getState(), scopeKey)
  )
}

describe('workspace chat drafts on removal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.remove.mockResolvedValue(undefined)
    mockApi.repos.removeForHost.mockResolvedValue(undefined)
    clearNativeChatComposerDraftsForTests()
    clearNativeChatPendingAttachmentsForTests()
  })

  it('deletes a draft an upload wrote after its chat’s tab closed, by the owner it began in', async () => {
    const store = createTestStore()
    seedWorktree(store)
    trackDraftOwners(store)
    const later = structuredAgentSessionDraftScopeKey('session-later')
    seedStore(store, {
      unifiedTabsByWorktree: {
        [WT1]: [
          ...(store.getState().unifiedTabsByWorktree[WT1] ?? []),
          makeUnifiedTab({
            id: 'later-tab',
            entityId: 'session-later',
            contentType: 'agent-session',
            worktreeId: WT1,
            groupId: 'group-1'
          })
        ]
      }
    })
    // As at startup: the saved drafts have loaded before any upload settles.
    await hydrateNativeChatComposerDrafts()
    pasteStillUploading(later)
    store.getState().closeUnifiedTab('later-tab')
    expect(uploadsComplete(later)).toEqual([later])

    await store.getState().removeWorktree({ id: WT1, executionHostId: null }, true)

    expect(draftImageCount(later)).toBe(0)
  })
})
