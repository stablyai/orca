import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import { makeAgentStatusEntry } from '@/runtime/sync-runtime-graph-test-harness'
import { paneHeaderSwitchAgent } from '../terminal-pane/use-terminal-pane-projection'
import {
  WORKTREE_ID,
  makeState,
  liveClaudeEntry
} from './tab-session-history-fixtures.test-fixture'
import {
  canPaneOfferResumeInNewChat,
  resolvePaneHeaderSwitchOffer
} from './tab-session-history-switch'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/agent-session-runtime-capabilities'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/structured-agent-session-surface-capabilities'

// Staged host answers, as in tab-session-history-switch.test.ts.
vi.mock('@/runtime/local-runtime-capabilities', async (importOriginal) => ({
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
vi.mock('@/lib/renderer-app-platform', () => ({ getRendererAppPlatform: () => 'darwin' }))

const claudePane = 'term-1:leaf-1'
const paneGate = (state: AppState, paneKey: string) =>
  canPaneOfferResumeInNewChat(state, { worktreeId: WORKTREE_ID, paneKey })

// The header's switch follows Hand Off (Brennan 11-01): shown for a live agent Chat UI can take
// over, disabled until its conversation is known, hidden once the pane is back at its shell.
describe('the pane header switch', () => {
  const headerOffer = (
    state: AppState,
    liveAgent: string | null,
    stopped = false,
    paneKey = claudePane
  ) => resolvePaneHeaderSwitchOffer(state, { worktreeId: WORKTREE_ID, paneKey, liveAgent, stopped })

  it('is enabled for a live agent whose conversation is known', () => {
    expect(headerOffer(makeState(liveClaudeEntry), 'claude')).toBe('available')
  })

  it('shows disabled for a live agent that has not reported its conversation yet', () => {
    const state = makeState({
      [claudePane]: makeAgentStatusEntry({
        agentType: 'claude',
        paneKey: claudePane,
        tabId: 'term-1',
        worktreeId: WORKTREE_ID
      })
    })
    expect(paneGate(state, claudePane)).toBe(false)
    expect(headerOffer(state, 'claude')).toBe('conversation-unknown')
  })

  it('hides once the agent exited, even with its conversation remembered', () => {
    const state = makeState(liveClaudeEntry)
    expect(paneGate(state, claudePane)).toBe(true)
    expect(headerOffer(state, null)).toBeNull()
  })

  // A conversation remembered from an earlier run in this pane, after that agent exited.
  const leaf = '11111111-1111-4111-8111-111111111111'
  const remembered = `term-1:${leaf}`
  const rememberedOnly = (): AppState => {
    makeState()
    useAppStore.setState({
      terminalLayoutsByTabId: {
        'term-1': {
          root: null,
          activeLeafId: leaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leaf]: 'pty-1' }
        }
      }
    })
    const store = () => useAppStore.getState()
    store().setAgentStatus(
      remembered,
      { state: 'done', prompt: 'hi', agentType: 'claude' },
      undefined,
      undefined,
      { tabId: 'term-1', worktreeId: WORKTREE_ID },
      { providerSession: { key: 'session_id', id: 'claude-session-1' } }
    )
    store().removeAgentStatus(remembered)
    return store()
  }

  it('never offers an earlier run\u2019s conversation for a new agent in the pane', () => {
    const state = rememberedOnly()
    expect(paneGate(state, remembered)).toBe(true)
    expect(headerOffer(state, 'claude', false, remembered)).toBe('conversation-unknown')
    expect(headerOffer(state, 'codex', false, remembered)).toBe('conversation-unknown')
  })

  it('stays on a pane a failed switch stopped, which its failure message points to', () => {
    const exit = { paneId: 1, exitCode: 0, startup: { command: '' }, agent: 'claude' as const }
    const stopped = paneHeaderSwitchAgent(undefined, { ...exit, reason: 'switch-stopped' })
    expect(stopped).toEqual({ agent: 'claude', stopped: true })
    expect(headerOffer(rememberedOnly(), stopped!.agent, stopped!.stopped, remembered)).toBe(
      'available'
    )
    expect(paneHeaderSwitchAgent(undefined, { ...exit, reason: 'process-failed' })).toBeNull()
    expect(paneHeaderSwitchAgent(undefined, undefined)).toBeNull()
    expect(paneHeaderSwitchAgent('codex', undefined)).toEqual({ agent: 'codex', stopped: false })
  })

  it('hides for an agent Chat UI cannot take over, and where Chat UI cannot run', () => {
    expect(headerOffer(makeState(liveClaudeEntry), 'gemini')).toBeNull()
    expect(headerOffer(makeState(liveClaudeEntry, { connectionId: 'dev-box' }), 'claude')).toBe(
      null
    )
  })
})
