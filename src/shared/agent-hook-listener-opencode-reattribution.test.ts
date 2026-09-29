import { describe, expect, it } from 'vitest'
import { normalizeHookPayload } from './agent-hook-listener'
import { createHookListenerState } from './agent-hook-listener/listener-state'
import { bindOpenCodeSession } from './agent-hook-listener/opencode-session-registry'
import { makePaneKey } from './stable-pane-id'

import type { HookListenerState } from './agent-hook-listener/listener-state'

const LEAF_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LEAF_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PANE_A = makePaneKey('tab-a', LEAF_A)
const PANE_B = makePaneKey('tab-b', LEAF_B)

function opencodeBusy(
  state: HookListenerState,
  paneKey: string,
  sessionId: string,
  launchToken = ''
): ReturnType<typeof normalizeHookPayload> {
  return normalizeHookPayload(
    state,
    'opencode',
    { paneKey, launchToken, payload: { hook_event_name: 'SessionBusy', sessionID: sessionId } },
    'production'
  )
}

describe('opencode shared-server reattribution (#21359)', () => {
  it('reattributes a bound session to its real pane', () => {
    const state = createHookListenerState()
    bindOpenCodeSession(state, 'ses_1', {
      paneKey: PANE_B,
      boundAt: 1,
      basis: 'creation-correlation'
    })
    const result = opencodeBusy(state, PANE_A, 'ses_1')
    expect(result?.paneKey).toBe(PANE_B)
    expect(result?.tabId).toBe('tab-b')
    expect(result?.payload.state).toBe('working')
  })

  it('keeps the stamped pane for unbound sessions', () => {
    const state = createHookListenerState()
    const result = opencodeBusy(state, PANE_A, 'ses_unknown')
    expect(result?.paneKey).toBe(PANE_A)
  })

  it('substitutes the bound pane live token so its fence passes', () => {
    const state = createHookListenerState()
    // A tokened post teaches the listener pane B's live token.
    normalizeHookPayload(
      state,
      'claude',
      { paneKey: PANE_B, launchToken: 'token-b-live', payload: { hook_event_name: 'Stop' } },
      'production'
    )
    bindOpenCodeSession(state, 'ses_1', {
      paneKey: PANE_B,
      boundAt: 1,
      basis: 'argv'
    })
    const result = opencodeBusy(state, PANE_A, 'ses_1')
    expect(result?.paneKey).toBe(PANE_B)
    expect(result?.launchToken).toBe('token-b-live')
  })

  it('leaves other sources untouched', () => {
    const state = createHookListenerState()
    bindOpenCodeSession(state, 'ses_1', {
      paneKey: PANE_B,
      boundAt: 1,
      basis: 'argv'
    })
    const result = normalizeHookPayload(
      state,
      'claude',
      { paneKey: PANE_A, payload: { hook_event_name: 'Stop', session_id: 'ses_1' } },
      'production'
    )
    expect(result?.paneKey).toBe(PANE_A)
  })

  it('never lets a stale same-pane stamp overwrite the live token', () => {
    const state = createHookListenerState()
    // A tokened post teaches the listener pane B's live token.
    normalizeHookPayload(
      state,
      'claude',
      { paneKey: PANE_B, launchToken: 'token-b-live', payload: { hook_event_name: 'Stop' } },
      'production'
    )
    bindOpenCodeSession(state, 'ses_1', {
      paneKey: PANE_B,
      boundAt: 1,
      basis: 'argv'
    })
    // The shared server's frozen stamp carries a stale token for the same pane.
    const result = opencodeBusy(state, PANE_B, 'ses_1', 'token-b-stale')
    expect(result?.paneKey).toBe(PANE_B)
    expect(result?.launchToken).toBe('token-b-live')
    // And the stale stamp must not have poisoned the cache: a later lookup
    // still returns the live token.
    const again = opencodeBusy(state, PANE_B, 'ses_1', 'token-b-stale')
    expect(again?.launchToken).toBe('token-b-live')
  })

  it('drops the stamped worktree when the binding has none', () => {
    const state = createHookListenerState()
    bindOpenCodeSession(state, 'ses_1', {
      paneKey: PANE_B,
      boundAt: 1,
      basis: 'argv'
    })
    const result = normalizeHookPayload(
      state,
      'opencode',
      {
        paneKey: PANE_A,
        worktreeId: 'repo::/stamped-worktree',
        payload: { hook_event_name: 'SessionBusy', sessionID: 'ses_1' }
      },
      'production'
    )
    expect(result?.paneKey).toBe(PANE_B)
    expect(result?.worktreeId).toBeUndefined()
  })
})
