import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAgentRowConversationName } from '../../../../shared/agent-row-conversation-name'
import { getDefaultSettings } from '../../../../shared/constants'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { resolveTerminalTabTitle } from '../../../../shared/tab-title-resolution'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'

const WORKTREE_ID = 'repo1::/path/wt1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function seedWorktree(store: ReturnType<typeof createTestStore>, enabled: boolean): string {
  seedStore(store, {
    settings: {
      ...getDefaultSettings('/tmp'),
      tabAutoGenerateTitle: enabled
    },
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
    }
  })
  return store.getState().createTab(WORKTREE_ID).id
}

describe('generated agent tab titles across provider sessions', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('replaces the first-prompt generated title when the provider session changes', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const tabId = seedWorktree(store, true)
    const paneKey = makePaneKey(tabId, LEAF_ID)
    const sessionMetadata = (id: string) => ({
      providerSession: { key: 'session_id' as const, id }
    })

    store.getState().setAgentStatus(
      paneKey,
      {
        state: 'working',
        prompt: 'Upload the Kimi-K3 model to GitHub',
        agentType: 'claude'
      },
      undefined,
      { updatedAt: 1_000 },
      undefined,
      sessionMetadata('claude-session-1')
    )
    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generatedTitle).toBe(
      'Upload the Kimi K3 model to GitHub'
    )

    vi.stubGlobal('window', { api: { gh: {} } })
    // Why: /clear finishes the previous turn (`done`) then starts a new
    // provider session on the same PTY. `existingProviderSession` is dropped
    // on done→working, so staleness must compare the previous entry's id.
    store.getState().setAgentStatus(
      paneKey,
      {
        state: 'done',
        prompt: 'Upload the Kimi-K3 model to GitHub',
        agentType: 'claude'
      },
      undefined,
      { updatedAt: 2_000 },
      undefined,
      sessionMetadata('claude-session-1')
    )
    store.getState().setAgentStatus(
      paneKey,
      {
        state: 'working',
        prompt: 'Can you please refactor the auth middleware to use JWT tokens?',
        agentType: 'claude'
      },
      undefined,
      { updatedAt: 3_000 },
      undefined,
      sessionMetadata('claude-session-2')
    )

    const tab = store.getState().tabsByWorktree[WORKTREE_ID][0]
    expect(tab.generatedTitle).toBe('Refactor the auth middleware to use JWT')
    expect(store.getState().unifiedTabsByWorktree[WORKTREE_ID][0].generatedLabel).toBe(
      'Refactor the auth middleware to use JWT'
    )
    expect(resolveTerminalTabTitle(tab, true)).toBe('Refactor the auth middleware to use JWT')
    expect(getAgentRowConversationName(tab, 'claude', true)).toBe(
      'Refactor the auth middleware to use JWT'
    )
  })

  it('keeps the first-prompt generated title across follow-up turns of the same session', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const tabId = seedWorktree(store, true)
    const paneKey = makePaneKey(tabId, LEAF_ID)
    const sessionMetadata = {
      providerSession: { key: 'session_id' as const, id: 'claude-session-1' }
    }

    store.getState().setAgentStatus(
      paneKey,
      {
        state: 'working',
        prompt: 'Upload the Kimi-K3 model to GitHub',
        agentType: 'claude'
      },
      undefined,
      { updatedAt: 1_000 },
      undefined,
      sessionMetadata
    )
    store.getState().setAgentStatus(
      paneKey,
      {
        state: 'working',
        prompt: 'Can you please refactor the auth middleware to use JWT tokens?',
        agentType: 'claude'
      },
      undefined,
      { updatedAt: 3_000 },
      undefined,
      sessionMetadata
    )

    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generatedTitle).toBe(
      'Upload the Kimi K3 model to GitHub'
    )
  })
})
