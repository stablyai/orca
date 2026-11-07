import { applyProviderSessionOnlyUpdate } from '@/hooks/ipc-events/agent-status-partial-updates'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  makeRepo,
  makeTerminalTab,
  makeWorktree
} from '../worktree-jump/worktree-jump-palette-test-fixtures'

import { resolveCliChatResumeSource } from './cli-chat-resume-source'

import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/agent-session-runtime-capabilities'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/structured-agent-session-surface-capabilities'
import { resetAiVaultForcedRescanThrottleForTest } from '../right-sidebar/ai-vault/scanning/ai-vault-session-refresh'

import { canPaneOfferResumeInNewChat } from './tab-session-history-switch'

const mocks = vi.hoisted(() => {
  const state: {
    resumeState: { blocked: boolean; worktreeId: string | null }
    platform: string
  } = { resumeState: { blocked: false, worktreeId: 'repo-1::/repo/wt' }, platform: 'darwin' }
  return { ...state, resumeInChat: vi.fn() }
})

// Staged host answers: its capabilities arrive over IPC at boot, and the platform from preload.
vi.mock('@/runtime/hosts/capabilities/local-runtime-capabilities', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readLocalRuntimeCapabilitiesOrUnknown: () => [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
  ]
}))
vi.mock('@/runtime/host-structured-agents', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readHostStructuredAgents: () =>
    ['claude', 'codex', 'grok', 'omp', 'opencode', 'pi'].map((agent) => ({
      agent,
      capabilities: {}
    }))
}))
vi.mock('@/lib/renderer-app-platform', () => ({ getRendererAppPlatform: () => mocks.platform }))

vi.mock(
  '../right-sidebar/ai-vault/session-actions/ai-vault-session-resume-in-chat-workspace',
  () => ({
    resolveAiVaultHistoryRowResume: () => ({
      resumeState: { ...mocks.resumeState, usesSessionWorktree: true },
      resumeInChat: mocks.resumeInChat()
    })
  })
)

const WORKTREE_ID = 'repo-1::/repo/wt'

const SIBLING_ID = 'repo-1::/repo/sibling'

function makeState(
  agentStatusByPaneKey: AppState['agentStatusByPaneKey'] = {},
  repo: Partial<ReturnType<typeof makeRepo>> = {}
): AppState {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    agentStatusByPaneKey,
    activeRepoId: 'repo-1',
    activeWorktreeId: WORKTREE_ID,
    repos: [{ ...makeRepo(), ...repo }],
    tabsByWorktree: {
      [WORKTREE_ID]: [makeTerminalTab('term-1', WORKTREE_ID, 'claude')]
    },
    worktreesByRepo: {
      'repo-1': [
        makeWorktree(WORKTREE_ID, 'wt', { path: '/repo/wt' }),
        makeWorktree(SIBLING_ID, 'sibling', { path: '/repo/sibling' })
      ]
    }
  })
  return useAppStore.getState()
}

beforeEach(() => {
  resetAiVaultForcedRescanThrottleForTest()
  mocks.resumeState = { blocked: false, worktreeId: WORKTREE_ID }
  mocks.platform = 'darwin'
  mocks.resumeInChat.mockReset()
})

// What Orca remembers once the agent exits and the pane is back at its shell prompt.

describe('one pane of a terminal tab', () => {
  const paneGate = (state: AppState, paneKey: string) =>
    canPaneOfferResumeInNewChat(state, { worktreeId: WORKTREE_ID, paneKey })
  it('identifies a provider-only Continue source without a live turn or selecting its sibling', () => {
    makeState()
    const [L1, L2] = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222'
    ]
    const pane = `term-1:${L1}`
    const layout = (ptyIdsByLeafId: Record<string, string>) =>
      useAppStore.setState({
        terminalLayoutsByTabId: {
          'term-1': { root: null, activeLeafId: L1, expandedLeafId: null, ptyIdsByLeafId }
        }
      })
    layout({ [L1]: 'pty-1', [L2]: 'pty-2' })
    applyProviderSessionOnlyUpdate({
      store: useAppStore.getState(),
      batch: undefined,
      paneKey: pane,
      routing: { tabId: 'term-1', worktreeId: WORKTREE_ID },
      data: {
        paneKey: pane,
        connectionId: null,
        receivedAt: 1,
        stateStartedAt: 1,
        state: 'done',
        prompt: '',
        agentType: 'codex',
        providerSession: { key: 'session_id', id: 'thread-c' },
        providerSessionOnly: true
      }
    })
    const state = useAppStore.getState()
    expect(state.agentStatusByPaneKey).toEqual({})
    expect(
      resolveCliChatResumeSource(state, {
        tab: { id: 'term-1', worktreeId: WORKTREE_ID },
        paneKey: pane
      })
    ).toMatchObject({ agent: 'codex', providerSessionId: 'thread-c' })
    expect(paneGate(state, `term-1:${L2}`)).toBe(false)
    useAppStore
      .getState()
      .setAgentStatus(
        pane,
        { state: 'done', prompt: 'first', agentType: 'codex' },
        undefined,
        undefined,
        { tabId: 'term-1', worktreeId: WORKTREE_ID },
        { providerSession: { key: 'session_id', id: 'thread-c' } }
      )
    useAppStore
      .getState()
      .setAgentStatus(pane, { state: 'working', prompt: 'second', agentType: 'codex' })
    expect(
      resolveCliChatResumeSource(useAppStore.getState(), {
        tab: { id: 'term-1', worktreeId: WORKTREE_ID },
        paneKey: pane
      })
    ).toBeNull()
    expect(paneGate(useAppStore.getState(), pane)).toBe(false)
    useAppStore
      .getState()
      .recordAgentProviderSession(
        pane,
        'codex',
        { key: 'session_id', id: 'thread-next' },
        undefined,
        { tabId: 'term-1', worktreeId: WORKTREE_ID }
      )
    expect(
      resolveCliChatResumeSource(useAppStore.getState(), {
        tab: { id: 'term-1', worktreeId: WORKTREE_ID },
        paneKey: pane
      })
    ).toMatchObject({ providerSessionId: 'thread-next' })
  })
})
