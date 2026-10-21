import { describe, expect, it } from 'vitest'
import { createHookListenerState } from './agent-hook-listener/listener-state'
import {
  bindOpenCodeSession,
  lookupOpenCodePaneLaunchToken,
  lookupOpenCodeSessionPane,
  moveOpenCodeSessionBindings,
  OPENCODE_SESSION_BINDINGS_MAX,
  trackOpenCodePaneLaunchToken,
  unbindOpenCodeSessionsOfPane
} from './agent-hook-listener/opencode-session-registry'
import { makePaneKey } from './stable-pane-id'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const PANE_A = makePaneKey('tab-a', LEAF_A)
const PANE_B = makePaneKey('tab-b', LEAF_B)

describe('opencode session registry', () => {
  it('binds and looks up a session owner', () => {
    const state = createHookListenerState()
    expect(
      bindOpenCodeSession(state, 'ses_1', { paneKey: PANE_A, boundAt: 1, basis: 'argv' })
    ).toBe(true)
    expect(lookupOpenCodeSessionPane(state, 'ses_1')?.paneKey).toBe(PANE_A)
    expect(lookupOpenCodeSessionPane(state, 'ses_unknown')).toBeUndefined()
  })

  it('refuses blank ids and malformed pane keys', () => {
    const state = createHookListenerState()
    expect(bindOpenCodeSession(state, '  ', { paneKey: PANE_A, boundAt: 1, basis: 'argv' })).toBe(
      false
    )
    expect(
      bindOpenCodeSession(state, 'ses_1', { paneKey: 'not-a-pane', boundAt: 1, basis: 'argv' })
    ).toBe(false)
    expect(state.opencodeSessionPaneBySessionId.size).toBe(0)
  })

  it('rebinds a session to a new owner and refreshes eviction order', () => {
    const state = createHookListenerState()
    bindOpenCodeSession(state, 'ses_1', { paneKey: PANE_A, boundAt: 1, basis: 'argv' })
    bindOpenCodeSession(state, 'ses_1', {
      paneKey: PANE_B,
      boundAt: 2,
      basis: 'creation-correlation'
    })
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
    expect(lookupOpenCodeSessionPane(state, 'ses_3')?.paneKey).toBe(PANE_B)
  })

  it('moves bindings with a pane', () => {
    const state = createHookListenerState()
    bindOpenCodeSession(state, 'ses_1', { paneKey: PANE_A, boundAt: 1, basis: 'argv' })
    moveOpenCodeSessionBindings(state, PANE_A, PANE_B)
    expect(lookupOpenCodeSessionPane(state, 'ses_1')?.paneKey).toBe(PANE_B)
  })

  it('tracks last-seen launch tokens per pane', () => {
    const state = createHookListenerState()
    trackOpenCodePaneLaunchToken(state, PANE_A, '  ')
    expect(lookupOpenCodePaneLaunchToken(state, PANE_A)).toBeUndefined()
    trackOpenCodePaneLaunchToken(state, PANE_A, 'token-1')
    trackOpenCodePaneLaunchToken(state, PANE_A, 'token-2')
    expect(lookupOpenCodePaneLaunchToken(state, PANE_A)).toBe('token-2')
  })
})
