import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import type { AgentSessionLaunchPlan } from '@/lib/agent-session-launch-plan'

const holder = vi.hoisted(() => {
  const state: { store: unknown } = { store: null }
  return state
})

vi.mock('@/store', () => ({
  get useAppStore() {
    return holder.store
  }
}))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: {} }

import { createTestStore, seedStore } from '../store/slices/store-test-helpers'
import {
  beginStructuredAgentSessionProvisionalLaunch,
  openStructuredAgentSessionProvisionalTab
} from './structured-agent-session-provisional-tab'
import {
  clearStructuredAgentLaunchDraftForSession,
  seedStructuredAgentLaunchDraft
} from './structured-agent-session-launch-draft'

const WT = 'repo1::/path/wt1'

let store: ReturnType<typeof createTestStore>

function chatTabs(): Tab[] {
  return (store.getState().unifiedTabsByWorktree[WT] ?? []).filter(
    (tab) => tab.contentType === 'agent-session'
  )
}

/** A chat whose conversation was replaced (/clear, /compact): same tab, new session behind it. */
function seedReplacedChat(): void {
  seedStore(store, {
    unifiedTabsByWorktree: {
      [WT]: [
        {
          id: 'chat-tab-1',
          entityId: 'session-after-clear',
          groupId: 'group-1',
          worktreeId: WT,
          contentType: 'agent-session',
          agentSessionAgent: 'codex',
          label: 'Codex Chat',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    groupsByWorktree: {
      [WT]: [{ id: 'group-1', worktreeId: WT, activeTabId: 'chat-tab-1', tabOrder: ['chat-tab-1'] }]
    }
  })
}

beforeEach(() => {
  store = createTestStore()
  holder.store = store
})

describe('structured chat tab identity', () => {
  it('mints its own id and names its session only through entityId', () => {
    const tab = openStructuredAgentSessionProvisionalTab({
      worktreeId: WT,
      sessionId: 'session-1',
      agent: 'codex'
    })

    expect(tab.entityId).toBe('session-1')
    expect(tab.id).not.toContain('session-1')
    expect(chatTabs()).toEqual([expect.objectContaining({ id: tab.id, entityId: 'session-1' })])
  })

  it('finds the tab for a session by entityId after its conversation was replaced', () => {
    seedReplacedChat()

    const tab = openStructuredAgentSessionProvisionalTab({
      worktreeId: WT,
      sessionId: 'session-after-clear',
      agent: 'codex'
    })

    expect(tab.id).toBe('chat-tab-1')
    expect(chatTabs()).toHaveLength(1)
  })

  it('seeds the launch draft under the same tab id the chat reads it by', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch only calls begin() on its plan; the other members are never read.
    const plan = {
      worktreeId: WT,
      agent: 'codex',
      begin: () => ({
        sessionId: 'session-draft',
        settlement: new Promise(() => {}),
        cancel: vi.fn(),
        seedLaunchDraft: (tabId: string) =>
          seedStructuredAgentLaunchDraft(tabId, 'codex', {
            prompt: 'PR #1 context',
            promptDelivery: 'draft'
          })
      })
    } as unknown as AgentSessionLaunchPlan

    const launch = beginStructuredAgentSessionProvisionalLaunch({ plan, hooks: {} })

    expect(launch).not.toBeNull()
    const drafts = store.getState().nativeChatLaunchDraftByTabId
    expect(Object.keys(drafts)).toEqual([launch!.tab.id])
    expect(drafts[launch!.tab.id]?.text).toBe('PR #1 context')
  })

  it('clears a cancelled launch draft from the tab found by entityId', () => {
    seedReplacedChat()
    seedStructuredAgentLaunchDraft('chat-tab-1', 'codex', {
      prompt: 'PR #1 context',
      promptDelivery: 'draft'
    })

    clearStructuredAgentLaunchDraftForSession(WT, 'session-after-clear')

    expect(store.getState().nativeChatLaunchDraftByTabId['chat-tab-1']).toBeUndefined()
  })
})
