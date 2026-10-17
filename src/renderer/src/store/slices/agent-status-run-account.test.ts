import { describe, expect, it } from 'vitest'
import { createTestStore } from './store-test-helpers'
import { normalizeAgentStatusMetadata } from '../../hooks/ipc-events/normalize-agent-status-event'
import type { AgentRunAccount } from '../../../../shared/agent-run-account'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
const KEPT: AgentRunAccount = {
  provider: 'codex',
  lane: 'host',
  accountId: 'account-a',
  mode: 'kept'
}

function hostRow(overrides: Partial<AgentStatusIpcPayload>): AgentStatusIpcPayload {
  return {
    paneKey: PANE,
    connectionId: null,
    receivedAt: 1_000,
    stateStartedAt: 1_000,
    state: 'working',
    prompt: 'go',
    agentType: 'codex',
    ...overrides
  }
}

describe("the host's run-account facet on a renderer status entry", () => {
  it('lands verbatim from a host row and is absent when the host never sent one', () => {
    const store = createTestStore()
    store
      .getState()
      .setAgentStatus(
        PANE,
        { state: 'working', prompt: 'go', agentType: 'codex' },
        undefined,
        { updatedAt: 1_000, stateStartedAt: 1_000 },
        undefined,
        normalizeAgentStatusMetadata(hostRow({}))
      )
    expect(store.getState().agentStatusByPaneKey[PANE]).not.toHaveProperty('runAccount')

    store
      .getState()
      .setAgentStatus(
        PANE,
        { state: 'working', prompt: 'go', agentType: 'codex' },
        undefined,
        { updatedAt: 2_000, stateStartedAt: 1_000 },
        undefined,
        normalizeAgentStatusMetadata(hostRow({ receivedAt: 2_000, runAccount: KEPT }))
      )
    expect(store.getState().agentStatusByPaneKey[PANE]?.runAccount).toEqual(KEPT)
  })

  it('survives a renderer-local row of the same agent and clears on a host withdrawal', () => {
    const store = createTestStore()
    store
      .getState()
      .setAgentStatus(
        PANE,
        { state: 'working', prompt: 'go', agentType: 'codex' },
        undefined,
        { updatedAt: 1_000, stateStartedAt: 1_000 },
        undefined,
        normalizeAgentStatusMetadata(hostRow({ runAccount: KEPT }))
      )
    // An OSC repaint parsed in the renderer carries no host metadata.
    store.getState().setAgentStatus(PANE, {
      state: 'working',
      prompt: 'go',
      agentType: 'codex',
      toolName: 'Bash'
    })
    expect(store.getState().agentStatusByPaneKey[PANE]?.runAccount).toEqual(KEPT)

    store
      .getState()
      .setAgentStatus(
        PANE,
        { state: 'working', prompt: 'go', agentType: 'codex' },
        undefined,
        { updatedAt: Date.now() + 1_000, stateStartedAt: 1_000 },
        undefined,
        normalizeAgentStatusMetadata(hostRow({ runAccount: null }))
      )
    expect(store.getState().agentStatusByPaneKey[PANE]).not.toHaveProperty('runAccount')
  })

  it('drops the facet when another agent takes the pane', () => {
    const store = createTestStore()
    store
      .getState()
      .setAgentStatus(
        PANE,
        { state: 'done', prompt: 'go', agentType: 'codex' },
        undefined,
        { updatedAt: 1_000, stateStartedAt: 1_000 },
        undefined,
        normalizeAgentStatusMetadata(hostRow({ state: 'done', runAccount: KEPT }))
      )
    store.getState().setAgentStatus(PANE, { state: 'working', prompt: 'hi', agentType: 'claude' })

    expect(store.getState().agentStatusByPaneKey[PANE]?.agentType).toBe('claude')
    expect(store.getState().agentStatusByPaneKey[PANE]).not.toHaveProperty('runAccount')
  })

  it('ignores a malformed facet from the wire', () => {
    const metadata = normalizeAgentStatusMetadata(
      hostRow({ runAccount: { ...KEPT, accountId: '../x' } })
    )
    expect(metadata).toBeUndefined()
  })
})
