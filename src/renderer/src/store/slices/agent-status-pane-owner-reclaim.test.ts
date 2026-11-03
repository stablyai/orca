import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectiveAgentStatusOwnerType } from '../../../../shared/agent-status-types'
import { createTestStore } from './store-test-helpers'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const NOW = Date.UTC(2026, 9, 25, 12)

afterEach(() => vi.useRealTimers())

// #30589: a nested agent's row arrived while the owner idled; the owner's next hook must land.
function reclaim(session?: string) {
  const store = createTestStore()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  store
    .getState()
    .setAgentStatus(PANE_KEY, { state: 'working', prompt: 'Background job', agentType: 'claude' })
  store.getState().setAgentStatus(
    PANE_KEY,
    { state: 'working', prompt: 'Next task', agentType: 'codex' },
    undefined,
    { updatedAt: NOW + 1 },
    undefined,
    session
      ? {
          paneOwner: { agent: 'codex', session: 'owner' },
          providerSession: { key: 'session_id', id: session }
        }
      : undefined
  )
  return store.getState().agentStatusByPaneKey[PANE_KEY]
}

describe('pane owner reclaim', () => {
  it("accepts the owner's hook over a fresh nested-agent row", () => {
    expect(reclaim('owner')).toMatchObject({
      agentType: 'codex',
      prompt: 'Next task'
    })
  })

  it.each([undefined, 'nested-exec'])('suppresses a different agent from session %s', (session) => {
    expect(reclaim(session)).toMatchObject({ agentType: 'claude', prompt: 'Background job' })
  })

  it('suppresses a nested grok hook when antigravity is the paneOwner even after turn completion', () => {
    const store = createTestStore()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'done', prompt: 'Foreground Agy task', agentType: 'antigravity' },
        undefined,
        { updatedAt: NOW },
        undefined,
        {
          paneOwner: { agent: 'antigravity', session: 'agy-conv-1' },
          providerSession: { key: 'conversation_id', id: 'agy-conv-1' }
        }
      )
    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'Background Grok subagent', agentType: 'grok' },
        undefined,
        { updatedAt: NOW + 6 * 60_000 },
        undefined,
        {
          paneOwner: { agent: 'antigravity', session: 'agy-conv-1' },
          providerSession: { key: 'session_id', id: 'grok-subagent-1' }
        }
      )
    expect(store.getState().agentStatusByPaneKey[PANE_KEY]).toMatchObject({
      agentType: 'antigravity',
      state: 'done',
      prompt: 'Foreground Agy task',
      paneOwner: { agent: 'antigravity', session: 'agy-conv-1' }
    })
  })

  it('allows a new foreground agent to replace a completed paneOwner once foreground returns to shell or switches process', () => {
    const store = createTestStore()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'done', prompt: 'Foreground Agy task', agentType: 'antigravity' },
        undefined,
        { updatedAt: NOW },
        undefined,
        {
          paneOwner: { agent: 'antigravity', session: 'agy-conv-1' },
          providerSession: { key: 'conversation_id', id: 'agy-conv-1' }
        }
      )
    store.setState({
      paneForegroundAgentByPaneKey: {
        [PANE_KEY]: {
          agent: null,
          shellForeground: true
        }
      }
    })
    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'Direct Grok session', agentType: 'grok' },
        undefined,
        { updatedAt: NOW + 1_000 },
        undefined,
        {
          paneOwner: { agent: 'antigravity', session: 'agy-conv-1' },
          providerSession: { key: 'session_id', id: 'grok-direct-1' }
        }
      )
    const entry = store.getState().agentStatusByPaneKey[PANE_KEY]
    expect(entry).toMatchObject({
      agentType: 'grok',
      state: 'working',
      prompt: 'Direct Grok session'
    })
    expect(entry?.paneOwner).toBeUndefined()
    expect(effectiveAgentStatusOwnerType(entry)).toBe('grok')
  })
})
