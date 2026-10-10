import { describe, expect, it, vi } from 'vitest'
import { normalizeHookPayload } from './agent-hook-listener'
import { createHookListenerState } from './agent-hook-listener/listener-state'
import {
  bindOpenCodeSession,
  bindOpenCodeTuiSession,
  lookupOpenCodeSessionPane,
  moveOpenCodeSessionBindings,
  trackOpenCodePaneLaunchToken,
  unbindOpenCodeSessionsOfPane
} from './agent-hook-listener/opencode-session-registry'
import { makePaneKey } from './stable-pane-id'

const PANE_A = makePaneKey('tab-a', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
const PANE_B = makePaneKey('tab-b', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
const body = (paneKey = PANE_B, extra = {}) => ({
  paneKey,
  worktreeId: 'folder::same-folder',
  launchToken: 'live-token',
  env: 'test',
  opencodeTui: 1,
  payload: { hook_event_name: 'SessionBusy', sessionID: 'ses_b' },
  ...extra
})

describe('legacy structural TUI identity at the execution-host boundary', () => {
  it('binds accepted structural evidence and suppresses subsequent shared aggregate posts', () => {
    const state = createHookListenerState()
    const tui = body()
    expect(normalizeHookPayload(state, 'opencode', tui, 'test')?.paneKey).toBe(PANE_B)
    expect(lookupOpenCodeSessionPane(state, 'ses_b')).toBeUndefined()
    bindOpenCodeTuiSession(state, 'opencode', tui, 'ses_b')
    expect(lookupOpenCodeSessionPane(state, 'ses_b')).toMatchObject({
      paneKey: PANE_B,
      worktreeId: 'folder::same-folder',
      basis: 'tui'
    })
    expect(
      normalizeHookPayload(
        state,
        'opencode',
        body(PANE_A, { opencodeTui: undefined, opencodeSharedServer: 1 }),
        'test'
      )
    ).toBeNull()
    expect(
      normalizeHookPayload(state, 'opencode', body(PANE_A, { opencodeTui: undefined }), 'test')
    ).toBeNull()
  })

  it('preserves a known creator when a second pane views the same session', () => {
    const state = createHookListenerState()
    bindOpenCodeSession(state, 'ses_b', {
      paneKey: PANE_A,
      worktreeId: 'original-folder',
      boundAt: 1,
      basis: 'argv'
    })
    const tui = body()
    expect(normalizeHookPayload(state, 'opencode', tui, 'test')).toMatchObject({
      paneKey: PANE_A,
      worktreeId: 'original-folder'
    })
    bindOpenCodeTuiSession(state, 'opencode', tui, 'ses_b')
    expect(lookupOpenCodeSessionPane(state, 'ses_b')).toMatchObject({
      paneKey: PANE_A,
      worktreeId: 'original-folder',
      basis: 'tui'
    })
  })

  it('checks the physical identity before creator rewriting or listener cache mutation', () => {
    const state = createHookListenerState()
    bindOpenCodeSession(state, 'ses_b', { paneKey: PANE_A, boundAt: 1, basis: 'argv' })
    trackOpenCodePaneLaunchToken(state, PANE_A, 'creator-live')
    const tokens = [...state.lastLaunchTokenByPaneKey]
    const owner = lookupOpenCodeSessionPane(state, 'ses_b')
    const admitOpenCodeTui = vi.fn(() => false)
    expect(normalizeHookPayload(state, 'opencode', body(), 'test', { admitOpenCodeTui })).toBeNull()
    expect(admitOpenCodeTui).toHaveBeenCalledExactlyOnceWith({
      paneKey: PANE_B,
      launchToken: 'live-token',
      hookEventName: 'SessionBusy',
      hasExplicitPrompt: false
    })
    expect([...state.lastLaunchTokenByPaneKey]).toEqual(tokens)
    expect(lookupOpenCodeSessionPane(state, 'ses_b')).toBe(owner)
    expect(state.lastStatusByPaneKey.size).toBe(0)
    expect(state.lastPromptByProducerKey.size).toBe(0)
  })

  it.each([{ opencodeTui: undefined }, { opencodeMajor: 2 }])(
    'keeps frozen server and v2 posts outside physical legacy TUI admission: %j',
    (extra) => {
      const state = createHookListenerState()
      bindOpenCodeSession(state, 'ses_b', { paneKey: PANE_A, boundAt: 1, basis: 'argv' })
      const admitOpenCodeTui = vi.fn(() => false)
      const event = normalizeHookPayload(state, 'opencode', body(PANE_B, extra), 'test', {
        admitOpenCodeTui
      })
      expect(event?.paneKey).toBe('opencodeMajor' in extra ? PANE_B : PANE_A)
      expect(admitOpenCodeTui).not.toHaveBeenCalled()
    }
  )

  it('keeps an existing server owner before structural evidence and abstains on capable unknown sessions', () => {
    const state = createHookListenerState()
    const shared = body(PANE_A, { opencodeTui: undefined, opencodeSharedServer: 1 })
    expect(normalizeHookPayload(state, 'opencode', shared, 'test')).toBeNull()
    const oldServer = body(PANE_A, { opencodeTui: undefined })
    expect(normalizeHookPayload(state, 'opencode', oldServer, 'test')?.paneKey).toBe(PANE_A)
    bindOpenCodeSession(state, 'ses_b', { paneKey: PANE_B, boundAt: 1, basis: 'argv' })
    expect(normalizeHookPayload(state, 'opencode', shared, 'test')?.paneKey).toBe(PANE_B)
  })

  it.each(['opencode2', 'mimo-code', 'claude'] as const)(
    'does not bind another provider: %s',
    (source) => {
      const state = createHookListenerState()
      bindOpenCodeTuiSession(state, source, body(), 'ses_b')
      expect(lookupOpenCodeSessionPane(state, 'ses_b')).toBeUndefined()
    }
  )

  it('keeps OpenCode 2 off the legacy binder even when an old id or optional marker coincides', () => {
    const state = createHookListenerState()
    bindOpenCodeSession(state, 'ses_b', { paneKey: PANE_A, boundAt: 1, basis: 'tui' })
    const next = body(PANE_B, { opencodeMajor: 2 })
    bindOpenCodeTuiSession(state, 'opencode', next, 'ses_b')
    expect(lookupOpenCodeSessionPane(state, 'ses_b')?.paneKey).toBe(PANE_A)
    expect(normalizeHookPayload(state, 'opencode', next, 'test')?.paneKey).toBe(PANE_B)
  })

  it('moves and tears down structural bindings using the existing pane lifecycle', () => {
    const state = createHookListenerState()
    bindOpenCodeTuiSession(state, 'opencode', body(PANE_A), 'ses_b')
    moveOpenCodeSessionBindings(state, PANE_A, PANE_B)
    expect(lookupOpenCodeSessionPane(state, 'ses_b')?.paneKey).toBe(PANE_B)
    unbindOpenCodeSessionsOfPane(state, PANE_B)
    expect(lookupOpenCodeSessionPane(state, 'ses_b')).toBeUndefined()
    bindOpenCodeTuiSession(state, 'opencode', body(PANE_A), 'ses_b')
    expect(lookupOpenCodeSessionPane(state, 'ses_b')?.paneKey).toBe(PANE_A)
  })

  it('requires a real provider session for structural evidence', () => {
    const state = createHookListenerState()
    expect(
      normalizeHookPayload(
        state,
        'opencode',
        body(PANE_B, { payload: { hook_event_name: 'SessionBusy' } }),
        'test'
      )
    ).toBeNull()
    bindOpenCodeTuiSession(state, 'opencode', body(), undefined)
    expect(lookupOpenCodeSessionPane(state, 'ses_b')).toBeUndefined()
  })
})
