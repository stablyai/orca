import { afterEach, describe, expect, it, vi } from 'vitest'

import { normalizeHookPayload } from './agent-hook-listener'

import {
  clearAllListenerCaches,
  createHookListenerState,
  movePaneCacheState
} from './agent-hook-listener/listener-state'
import { warnOnHookEnvOrVersionMismatch } from './agent-hook-listener/listener-limits'
import './agent-hook-listener/source-routing'
import { bindOpenCodeSession } from './agent-hook-listener/opencode-session-registry'
import { makePaneKey } from './stable-pane-id'

const PANE = makePaneKey('tab-hooks', '11111111-1111-4111-8112-111111111111')
const MOVED_PANE = makePaneKey('tab-hooks', '22222222-2222-4222-8222-222222222222')
afterEach(() => vi.restoreAllMocks())
describe('agent hook extraction boundaries', () => {
  it('warns before tab rejection and bounds distinct version and environment warnings', () => {
    const orderState = createHookListenerState()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(
      normalizeHookPayload(
        createHookListenerState(),
        'devin',
        { paneKey: PANE, payload: { hook_event_name: 'UserPromptSubmit' } },
        'production'
      )?.payload
    ).toMatchObject({ state: 'working', agentType: 'devin' })
    const rejected = normalizeHookPayload(
      orderState,
      'devin',
      {
        paneKey: PANE,
        tabId: 'wrong-tab',
        version: 'outdated',
        payload: { hook_event_name: 'UserPromptSubmit' }
      },
      'production'
    )
    expect(rejected).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)

    warn.mockClear()
    const repeatedState = createHookListenerState()
    for (let attempt = 0; attempt < 2; attempt++) {
      warnOnHookEnvOrVersionMismatch(repeatedState, {
        version: 'repeated-version',
        env: 'repeated-environment',
        expectedEnv: 'production'
      })
    }
    expect(warn).toHaveBeenCalledTimes(2)

    warn.mockClear()
    const cappedState = createHookListenerState()
    for (let index = 0; index < 40; index++) {
      warnOnHookEnvOrVersionMismatch(cappedState, {
        version: `version-${index}`,
        env: `environment-${index}`,
        expectedEnv: 'production'
      })
    }
    expect(cappedState.warnedVersions.size).toBe(32)
    expect(cappedState.warnedEnvs.size).toBe(32)
    expect(warn).toHaveBeenCalledTimes(64)
  })

  it('preserves bound OpenCode session ownership and launch identity after a pane move', () => {
    const state = createHookListenerState()
    normalizeHookPayload(
      state,
      'devin',
      {
        paneKey: PANE,
        launchToken: 'moved-launch',
        payload: { hook_event_name: 'UserPromptSubmit' }
      },
      'production'
    )
    expect(
      bindOpenCodeSession(state, 'moved-session', { paneKey: PANE, boundAt: 1, basis: 'argv' })
    ).toBe(true)
    movePaneCacheState(state, PANE, MOVED_PANE)
    const event = normalizeHookPayload(
      state,
      'opencode',
      {
        paneKey: PANE,
        opencodeSharedServer: 1,
        payload: { hook_event_name: 'SessionBusy', sessionID: 'moved-session' }
      },
      'production'
    )
    expect(event).toMatchObject({
      paneKey: MOVED_PANE,
      launchToken: 'moved-launch',
      payload: { state: 'working', agentType: 'opencode' }
    })
    expect(state.lastLaunchTokenByPaneKey.has(PANE)).toBe(false)
  })

  it('clears warning, provider, and lifecycle caches together', () => {
    const state = createHookListenerState()
    state.warnedVersions.add('old-version')
    state.warnedEnvs.add('development->production')
    state.lastPromptByPaneKey.set(PANE, 'prompt')
    state.claudeRunningNonAgentTaskPaneKeys.add(PANE)
    state.codexLeadStateByPaneKey.set(PANE, { state: 'working', stateStartedAt: 1 })
    state.grokActiveTurnByPaneKey.set(PANE, { promptId: 'prompt-1' })
    const notification = {
      paneKey: PANE,
      payload: { hook_event_name: 'Notification', notification_type: 'permission_prompt' }
    }
    normalizeHookPayload(
      state,
      'muse',
      {
        paneKey: PANE,
        payload: {
          hook_event_name: 'PermissionRequest',
          tool_name: 'stale-tool',
          tool_input: { command: 'old command' }
        }
      },
      'production'
    )
    expect(normalizeHookPayload(state, 'muse', notification, 'production')?.payload).toMatchObject({
      state: 'waiting',
      agentType: 'muse',
      toolName: 'stale-tool'
    })

    clearAllListenerCaches(state)

    expect(state.warnedVersions.size).toBe(0)
    expect(state.warnedEnvs.size).toBe(0)
    expect(state.lastPromptByPaneKey.size).toBe(0)
    expect(state.claudeRunningNonAgentTaskPaneKeys.size).toBe(0)
    expect(state.codexLeadStateByPaneKey.size).toBe(0)
    expect(state.grokActiveTurnByPaneKey.size).toBe(0)
    const afterReset = normalizeHookPayload(state, 'muse', notification, 'production')
    expect(afterReset?.payload).toMatchObject({ state: 'waiting', agentType: 'muse' })
    expect(afterReset?.payload.toolName).toBeUndefined()
  })
})
