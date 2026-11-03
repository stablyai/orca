import { describe, expect, it } from 'vitest'
import { createHookListenerState } from './agent-hook-listener/listener-state'
import {
  bindOpenCodeSession,
  lookupOpenCodeSessionPane,
  OPENCODE_SESSION_BINDINGS_MAX,
  unbindOpenCodeSessionsOfPane
} from './agent-hook-listener/opencode-session-registry'
import { makePaneKey } from './stable-pane-id'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const PANE_A = makePaneKey('tab-a', LEAF_A)
const PANE_B = makePaneKey('tab-b', LEAF_B)

describe('opencode session registry', () => {
  it('rebinds a session to a new owner and refreshes eviction order', () => {
    const state = createHookListenerState()
    bindOpenCodeSession(state, 'ses_1', { paneKey: PANE_A, boundAt: 1, basis: 'argv' })
    bindOpenCodeSession(state, 'ses_2', { paneKey: PANE_A, boundAt: 2, basis: 'argv' })
    bindOpenCodeSession(state, 'ses_1', {
      paneKey: PANE_B,
      boundAt: 3,
      basis: 'creation-correlation'
    })
    for (let i = 0; i < OPENCODE_SESSION_BINDINGS_MAX - 1; i += 1) {
      bindOpenCodeSession(state, `new_${i}`, { paneKey: PANE_A, boundAt: i + 4, basis: 'argv' })
    }
    expect(lookupOpenCodeSessionPane(state, 'ses_2')).toBeUndefined()
    expect(lookupOpenCodeSessionPane(state, 'ses_1')?.paneKey).toBe(PANE_B)
    expect(lookupOpenCodeSessionPane(state, 'ses_1')?.basis).toBe('creation-correlation')
  })

  it('evicts oldest-bound first once capped', () => {
    const state = createHookListenerState()
    for (let i = 0; i < OPENCODE_SESSION_BINDINGS_MAX + 5; i += 1) {
      bindOpenCodeSession(state, `ses_${i}`, { paneKey: PANE_A, boundAt: i, basis: 'argv' })
    }
    expect(state.opencodeSessionPaneBySessionId.size).toBe(OPENCODE_SESSION_BINDINGS_MAX)
    expect(lookupOpenCodeSessionPane(state, 'ses_0')).toBeUndefined()
    expect(
      lookupOpenCodeSessionPane(state, `ses_${OPENCODE_SESSION_BINDINGS_MAX + 4}`)
    ).toBeDefined()
  })

  it('unbinds every session of a closed pane', () => {
    const state = createHookListenerState()
    bindOpenCodeSession(state, 'ses_1', { paneKey: PANE_A, boundAt: 1, basis: 'argv' })
    bindOpenCodeSession(state, 'ses_2', { paneKey: PANE_A, boundAt: 2, basis: 'argv' })
    bindOpenCodeSession(state, 'ses_3', { paneKey: PANE_B, boundAt: 3, basis: 'argv' })
    expect(unbindOpenCodeSessionsOfPane(state, PANE_A)).toBe(2)
    expect(lookupOpenCodeSessionPane(state, 'ses_1')).toBeUndefined()
    expect(lookupOpenCodeSessionPane(state, 'ses_2')).toBeUndefined()
    expect(lookupOpenCodeSessionPane(state, 'ses_3')?.paneKey).toBe(PANE_B)
  })
})
