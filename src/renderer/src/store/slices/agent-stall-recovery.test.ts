import { describe, expect, it } from 'vitest'
import { createTestStore } from './store-test-helpers'
import {
  AGENT_STALL_MAX_TRACKED_PANES,
  buildAgentStallTabPrefixClearPatch
} from './agent-stall-recovery'
import {
  AGENT_STALL_ECHO_SUPPRESSION_MS,
  AGENT_STALL_EPISODE_RESET_MS,
  AGENT_STALL_OBSERVATION_TTL_MS
} from '../../../../shared/agent-stall-recovery-policy'

const NOW = 1_700_000_000_000

function observe(
  store: ReturnType<typeof createTestStore>,
  paneKey: string,
  overrides: { cause?: 'auth' | 'network'; signature?: string; observedAt?: number } = {}
): void {
  store.getState().observeAgentStall({
    paneKey,
    cause: overrides.cause ?? 'network',
    signature: overrides.signature ?? 'Connection error',
    observedAt: overrides.observedAt ?? NOW
  })
}

describe('agent stall recovery slice', () => {
  it('ignores a repeated identical observation but takes a newer one', () => {
    const store = createTestStore()

    observe(store, 'tab-1:a')
    const first = store.getState().agentStallByPaneKey
    observe(store, 'tab-1:a')

    expect(store.getState().agentStallByPaneKey).toBe(first)

    observe(store, 'tab-1:a', { observedAt: NOW + 1_000 })

    expect(store.getState().agentStallByPaneKey['tab-1:a'].observedAt).toBe(NOW + 1_000)
  })

  it('replaces the observation when the cause changes', () => {
    const store = createTestStore()

    observe(store, 'tab-1:a')
    observe(store, 'tab-1:a', { cause: 'auth', signature: 'Invalid API key' })

    expect(store.getState().agentStallByPaneKey['tab-1:a']).toMatchObject({
      cause: 'auth',
      signature: 'Invalid API key'
    })
  })

  it('drops expired observations and caps how many panes it tracks', () => {
    const store = createTestStore()

    observe(store, 'tab-old:a', { observedAt: NOW - AGENT_STALL_OBSERVATION_TTL_MS - 1_000 })
    for (let i = 0; i < AGENT_STALL_MAX_TRACKED_PANES + 5; i += 1) {
      observe(store, `tab-${i}:a`, { observedAt: NOW + i })
    }

    const tracked = store.getState().agentStallByPaneKey

    expect(Object.keys(tracked)).toHaveLength(AGENT_STALL_MAX_TRACKED_PANES)
    expect(tracked['tab-old:a']).toBeUndefined()
    // The cap keeps the newest, so the last pane observed must survive.
    expect(tracked[`tab-${AGENT_STALL_MAX_TRACKED_PANES + 4}:a`]).toBeDefined()
  })

  it('counts attempts per episode and keeps the ledger when an observation clears', () => {
    const store = createTestStore()
    observe(store, 'tab-1:a')

    store.getState().recordAgentStallRecoveryAttempt('tab-1:a', {
      cause: 'network',
      observedAt: NOW,
      attemptedAt: NOW + 1_000
    })
    store.getState().recordAgentStallRecoveryAttempt('tab-1:a', {
      cause: 'network',
      observedAt: NOW,
      attemptedAt: NOW + 2_000
    })

    expect(store.getState().agentStallRecoveryLedgerByPaneKey['tab-1:a']).toEqual({
      cause: 'network',
      attempts: 2,
      lastAttemptAt: NOW + 2_000
    })

    store.getState().clearAgentStallObservations(['tab-1:a'])

    expect(store.getState().agentStallByPaneKey['tab-1:a']).toBeUndefined()
    // Why kept: an immediate re-stall must keep spending the same budget.
    expect(store.getState().agentStallRecoveryLedgerByPaneKey['tab-1:a']?.attempts).toBe(2)
  })

  it('prunes ledger entries no observation and no live episode can reach', () => {
    const store = createTestStore()

    store.getState().recordAgentStallRecoveryAttempt('tab-stale:a', {
      cause: 'network',
      observedAt: NOW,
      attemptedAt: NOW
    })
    observe(store, 'tab-2:a', { observedAt: NOW + AGENT_STALL_EPISODE_RESET_MS + 60_000 })

    expect(store.getState().agentStallRecoveryLedgerByPaneKey['tab-stale:a']).toBeUndefined()
  })

  it('clears both maps for a retired tab, and only that tab', () => {
    const store = createTestStore()
    observe(store, 'tab-1:a')
    observe(store, 'tab-11:a')
    store.getState().recordAgentStallRecoveryAttempt('tab-1:a', {
      cause: 'network',
      observedAt: NOW,
      attemptedAt: NOW
    })

    store.getState().clearAgentStallsByTabPrefix('tab-1')

    expect(store.getState().agentStallByPaneKey['tab-1:a']).toBeUndefined()
    expect(store.getState().agentStallRecoveryLedgerByPaneKey['tab-1:a']).toBeUndefined()
    // `tab-11` must not be swept by `tab-1`'s prefix.
    expect(store.getState().agentStallByPaneKey['tab-11:a']).toBeDefined()
  })

  it('exposes the same clear as a patch for the retired-tab sweep', () => {
    const store = createTestStore()
    observe(store, 'tab-1:a')
    observe(store, 'tab-2:a')

    const patch = buildAgentStallTabPrefixClearPatch(store.getState(), ['tab-1:'])

    expect(Object.keys(patch?.agentStallByPaneKey ?? {})).toEqual(['tab-2:a'])
    expect(buildAgentStallTabPrefixClearPatch(store.getState(), ['tab-9:'])).toBeNull()
    expect(buildAgentStallTabPrefixClearPatch(store.getState(), [])).toBeNull()
  })

  // Regression (observed live): recovery types a prompt into the pane, the pane
  // echoes it, and the echo was recorded as a brand new stall.
  it('ignores an observation that is really the echo of its own recovery', () => {
    const store = createTestStore()
    observe(store, 'tab-1:a')
    store.getState().recordAgentStallRecoveryAttempt('tab-1:a', {
      cause: 'network',
      observedAt: NOW,
      attemptedAt: NOW + 1_000
    })
    store.getState().clearAgentStallObservations(['tab-1:a'])

    observe(store, 'tab-1:a', {
      cause: 'auth',
      signature: 'echo of the injected prompt',
      observedAt: NOW + 1_000 + AGENT_STALL_ECHO_SUPPRESSION_MS - 1
    })
    expect(store.getState().agentStallByPaneKey['tab-1:a']).toBeUndefined()

    // Past the window a real re-failure is recorded again.
    observe(store, 'tab-1:a', {
      cause: 'network',
      signature: 'API Error: Connection refused',
      observedAt: NOW + 1_000 + AGENT_STALL_ECHO_SUPPRESSION_MS
    })
    expect(store.getState().agentStallByPaneKey['tab-1:a']?.signature).toBe(
      'API Error: Connection refused'
    )
  })
})
