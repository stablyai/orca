import { applyAgentStatusPatch } from '../agent-status-patch'
import { createTestStore } from './store-test-helpers'
import { createAgentStatusRuntime } from './agent-status-runtime'
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AgentStatusPayload } from './agent-status-contract'
import { createAgentStatusLiveActions } from './agent-status-live-actions'

const NOW = new Date('2026-04-09T12:00:00.000Z').getTime()
const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

function existingEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    paneKey: PANE_KEY,
    state: 'working',
    prompt: 'parent turn',
    updatedAt: NOW,
    stateStartedAt: NOW,
    stateHistory: [],
    agentType: 'claude',
    ...overrides
  }
}

function setup(existing: AgentStatusEntry) {
  const store = createTestStore()
  applyAgentStatusPatch(store, { agentStatusByPaneKey: { [PANE_KEY]: existing } })
  const requestFreshness = vi.fn()
  const runtime = {
    ...createAgentStatusRuntime(store.setState, store.getState, store.getState),
    requestFreshness
  }
  return { requestFreshness, actions: createAgentStatusLiveActions(runtime) }
}

function payload(overrides: Partial<AgentStatusPayload> = {}): AgentStatusPayload {
  return { state: 'done', prompt: 'child hook', ...overrides }
}

describe('setAgentStatus freshness requests on rejected frames', () => {
  it('skips the deferred freshness scan when an inherited terminal status is suppressed', () => {
    // A nested child hook inherits ORCA_PANE_KEY, so its `done` is dropped while the parent works.
    const { requestFreshness, actions } = setup(existingEntry())

    actions.setAgentStatus(PANE_KEY, payload({ agentType: 'codex' }), undefined, {
      updatedAt: NOW + 1
    })

    expect(requestFreshness).not.toHaveBeenCalled()
  })

  it('still requests deferred freshness when a stale frame is rejected', () => {
    const { requestFreshness, actions } = setup(existingEntry())

    actions.setAgentStatus(PANE_KEY, payload({ agentType: 'claude' }), undefined, {
      updatedAt: NOW - 1
    })

    expect(requestFreshness).toHaveBeenCalledWith(false)
  })
})
