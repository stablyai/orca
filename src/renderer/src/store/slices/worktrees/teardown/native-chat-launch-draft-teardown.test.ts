/** Evict nativeChatLaunchDraftByTabId wherever launch prompt retires (close, orphan sweep, bulk/single purge); stranded drafts otherwise keep publishing to mobile. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'

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

// Main answers the window's chat-tab commands and its frames draw them (switch-on builds).
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

const mockApi = {
  worktrees: {
    remove: vi.fn().mockResolvedValue(undefined),
    forceDeletePreservedBranch: vi.fn().mockResolvedValue({ deleted: true }),
    updateMeta: vi.fn().mockResolvedValue({})
  },
  pty: { kill: vi.fn().mockResolvedValue(undefined) },
  runtimeEnvironments: { call: vi.fn().mockResolvedValue({ ok: true, result: {} }) }
}

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: mockApi }

import { createTestStore, seedStore } from '../../../testing/app-store-test-fixture'
import { makeWorktree } from '../worktree.test-fixture'
import { makeTab } from '../../../terminals/terminal-tab.test-fixture'
import { readNativeChatComposerDraft } from '@/components/native-chat/drafts/native-chat-composer-draft-store'
import {
  addNativeChatPendingAttachment,
  settleNativeChatPendingAttachment
} from '@/components/native-chat/attachments/chips/native-chat-pending-attachment-cache'

const WT1 = 'repo1::/path/wt1'
const WT2 = 'repo1::/path/wt2'
const TAB1 = 'tab-wt1'
const TAB2 = 'tab-wt2'

function draft(tabId: string, text: string) {
  return { tabId, agent: 'claude' as const, text, createdAt: 1 }
}

function seedDrafts(store: ReturnType<typeof createTestStore>): void {
  seedStore(store, {
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id: WT1, repoId: 'repo1', path: '/path/wt1' }),
        makeWorktree({ id: WT2, repoId: 'repo1', path: '/path/wt2' })
      ]
    },
    tabsByWorktree: {
      [WT1]: [makeTab({ id: TAB1, worktreeId: WT1 })],
      [WT2]: [makeTab({ id: TAB2, worktreeId: WT2 })]
    },
    nativeChatLaunchDraftByTabId: {
      [TAB1]: draft(TAB1, 'https://github.com/o/r/issues/1'),
      [TAB2]: draft(TAB2, 'https://github.com/o/r/issues/2')
    }
  })
}

describe('nativeChatLaunchDraftByTabId teardown', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.remove.mockResolvedValue(undefined)
  })

  it('a user tab close drops the uploads still on their way in that tab’s panes only', () => {
    const store = createTestStore()
    seedDrafts(store)
    for (const scopeKey of [`${TAB1}:leaf-b`, `${TAB2}:leaf-b`]) {
      addNativeChatPendingAttachment(scopeKey, { id: scopeKey, path: '', pending: true })
    }

    store.getState().closeTab(TAB2, { reason: 'pty-exit' })
    store.getState().closeTab(TAB1)

    const settled = [`${TAB1}:leaf-b`, `${TAB2}:leaf-b`].map((scopeKey) =>
      settleNativeChatPendingAttachment(scopeKey, scopeKey, '/store/a.png')
    )
    expect(settled).toEqual([false, true])
    expect(readNativeChatComposerDraft(`${TAB1}:leaf-b`).images).toEqual([])
  })
})
