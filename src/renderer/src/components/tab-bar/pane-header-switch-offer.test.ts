import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
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
  const headerOffer = (state: AppState, liveAgent: string | null) =>
    resolvePaneHeaderSwitchOffer(state, {
      worktreeId: WORKTREE_ID,
      paneKey: claudePane,
      liveAgent
    })

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

  it('stays on a pane a failed switch stopped, which its failure message points to', () => {
    const exit = { paneId: 1, exitCode: 0, startup: { command: '' }, agent: 'claude' as const }
    const stopped = paneHeaderSwitchAgent(undefined, { ...exit, reason: 'switch-stopped' })
    expect(headerOffer(makeState(liveClaudeEntry), stopped)).toBe('available')
    expect(paneHeaderSwitchAgent(undefined, { ...exit, reason: 'process-failed' })).toBeNull()
    expect(paneHeaderSwitchAgent(undefined, undefined)).toBeNull()
  })

  it('hides for an agent Chat UI cannot take over, and where Chat UI cannot run', () => {
    expect(headerOffer(makeState(liveClaudeEntry), 'gemini')).toBeNull()
    expect(headerOffer(makeState(liveClaudeEntry, { connectionId: 'dev-box' }), 'claude')).toBe(
      null
    )
  })
})
