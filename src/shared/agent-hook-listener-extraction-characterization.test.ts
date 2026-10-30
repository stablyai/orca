import { afterEach, describe, expect, it, vi } from 'vitest'

import { normalizeHookPayload } from './agent-hook-listener'
import type { AgentHookSource } from './agent-hook-relay'
import {
  clearAllListenerCaches,
  clearPaneCacheState,
  createHookListenerState,
  movePaneCacheState,
  seedLegacyAgentStatusForTests
} from './agent-hook-listener/listener-state'
import { warnOnHookEnvOrVersionMismatch } from './agent-hook-listener/listener-limits'
import { resolveHookSource } from './agent-hook-listener/source-routing'
import { bindOpenCodeSession } from './agent-hook-listener/opencode-session-registry'
import { makePaneKey } from './stable-pane-id'

const PANE = makePaneKey('tab-hooks', '11111111-1111-4111-8112-111111111111')
const MOVED_PANE = makePaneKey('tab-hooks', '22222222-2222-4222-8222-222222222222')
function normalizeProviderState(
  source: AgentHookSource,
  eventName: string,
  payload: Record<string, unknown> = {}
) {
  const routedSource = resolveHookSource(`/hook/${source}`)
  if (routedSource === null) {
    return null
  }
  return (
    normalizeHookPayload(
      createHookListenerState(),
      routedSource,
      { paneKey: PANE, hook_event_name: eventName, payload },
      'production'
    )?.payload ?? null
  )
}
afterEach(() => vi.restoreAllMocks())
describe('agent hook extraction boundaries', () => {
  it.each([
    ['qoder', 'UserPromptSubmit'],
    ['qoder-cn', 'UserPromptSubmit'],
    ['qwen-code', 'UserPromptSubmit'],
    ['codebuddy', 'UserPromptSubmit'],
    ['opencode2', 'SessionBusy'],
    ['muse', 'UserPromptSubmit'],
    ['zcode', 'UserPromptSubmit'],
    ['dsh', 'UserPromptSubmit'],
    ['kiro', 'userPromptSubmit']
  ] as const)('normalizes %s hook traffic through its routed source', (source, eventName) => {
    expect(normalizeProviderState(source, eventName, { prompt: 'routed prompt' })).toMatchObject({
      state: 'working',
      agentType: source,
      prompt: 'routed prompt'
    })
  })

  it('rejects unknown and malformed hook paths', () => {
    expect(resolveHookSource('/hook/unknown')).toBeNull()
    expect(resolveHookSource('/hook/devin/')).toBeNull()
    expect(resolveHookSource('/HOOK/DEVIN')).toBeNull()
  })

  it('preserves thin provider lifecycle branches and source attribution', () => {
    const cases = [
      ['devin', 'UserPromptSubmit', 'working'],
      ['devin', 'PermissionRequest', 'waiting'],
      ['devin', 'Stop', 'done'],
      ['mimo-code', 'MessagePart', 'working'],
      ['mimo-code', 'AskUserQuestion', 'waiting'],
      ['prime-agent', 'before_agent_start', 'working'],
      ['prime-agent', 'agent_end', 'done'],
      ['kimi', 'PermissionRequest', 'waiting'],
      ['kimi', 'StopFailure', 'done'],
      ['hermes', 'on_session_finalize', 'done'],
      ['hermes', 'on_session_reset', 'done']
    ] as const

    for (const [source, eventName, expectedState] of cases) {
      expect(normalizeProviderState(source, eventName)).toMatchObject({
        state: expectedState,
        agentType: source
      })
    }
    for (const source of ['devin', 'mimo-code', 'prime-agent', 'kimi', 'hermes'] as const) {
      expect(normalizeProviderState(source, 'UnknownEvent')).toBeNull()
    }
  })

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

  it('moves selected pane-owned collections and preserves NUL suffixes', () => {
    const state = createHookListenerState()
    const scoped = `${PANE}\0child`
    const movedScoped = `${MOVED_PANE}\0child`
    const sibling = `${PANE}-sibling`
    const paneMaps = [
      state.lastPromptByPaneKey,
      state.lastToolByPaneKey,
      state.antigravityCompletedTranscriptByPaneKey,
      state.claudeSubagentRosterByPaneKey,
      state.claudeLeadStateByPaneKey,
      state.codexSubagentRosterByPaneKey,
      state.codexSubagentTranscriptByPaneKey,
      state.codexLeadStateByPaneKey,
      state.grokActiveTurnByPaneKey
    ]
    for (const map of paneMaps) {
      const cache = map as Map<string, unknown>
      cache.set(PANE, 'exact')
      cache.set(scoped, 'scoped')
      cache.set(sibling, 'sibling')
    }
    for (const [paneKey, prompt] of [
      [PANE, 'exact'],
      [scoped, 'scoped'],
      [sibling, 'sibling']
    ]) {
      seedLegacyAgentStatusForTests(state, {
        paneKey,
        connectionId: null,
        payload: { state: 'working', prompt }
      })
    }
    const paneSets = [
      state.ampCompletedCacheKeys,
      state.claudeUnconfirmedRestoredStatusPaneKeys,
      state.claudeRunningNonAgentTaskPaneKeys,
      state.claudeActiveSessionCronPaneKeys
    ]
    for (const set of paneSets) {
      set.add(PANE)
      set.add(scoped)
      set.add(sibling)
    }

    movePaneCacheState(state, PANE, MOVED_PANE)

    for (const map of paneMaps) {
      const cache = map as Map<string, unknown>
      expect(cache.get(MOVED_PANE)).toBe('exact')
      expect(cache.get(movedScoped)).toBe('scoped')
      expect(cache.get(sibling)).toBe('sibling')
      expect(cache.has(PANE)).toBe(false)
      expect(cache.has(scoped)).toBe(false)
    }
    expect(state.lastStatusByPaneKey.get(MOVED_PANE)?.payload.prompt).toBe('exact')
    expect(state.lastStatusByPaneKey.get(movedScoped)?.payload.prompt).toBe('scoped')
    expect(state.lastStatusByPaneKey.get(sibling)?.payload.prompt).toBe('sibling')
    expect(state.lastStatusByPaneKey.has(PANE)).toBe(false)
    expect(state.lastStatusByPaneKey.has(scoped)).toBe(false)
    for (const set of paneSets) {
      expect(set.has(MOVED_PANE)).toBe(true)
      expect(set.has(movedScoped)).toBe(true)
      expect(set.has(sibling)).toBe(true)
      expect(set.has(PANE)).toBe(false)
      expect(set.has(scoped)).toBe(false)
    }

    movePaneCacheState(state, MOVED_PANE, MOVED_PANE)
    expect((state.lastPromptByPaneKey as Map<string, unknown>).get(MOVED_PANE)).toBe('exact')
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

  it('clears exact and NUL-scoped cache keys but not sibling prefixes', () => {
    const state = createHookListenerState()
    const scoped = `${PANE}\0thread`
    const sibling = `${PANE}-sibling`
    const paneMaps = [
      state.lastPromptByPaneKey,
      state.lastToolByPaneKey,
      state.antigravityCompletedTranscriptByPaneKey
    ]
    for (const map of paneMaps) {
      const cache = map as Map<string, unknown>
      cache.set(PANE, 'exact')
      cache.set(scoped, 'scoped')
      cache.set(sibling, 'sibling')
    }
    for (const [paneKey, prompt] of [
      [PANE, 'exact'],
      [scoped, 'scoped'],
      [sibling, 'sibling']
    ]) {
      seedLegacyAgentStatusForTests(state, {
        paneKey,
        connectionId: null,
        payload: { state: 'working', prompt }
      })
    }
    state.ampCompletedCacheKeys.add(PANE)
    state.ampCompletedCacheKeys.add(scoped)
    state.ampCompletedCacheKeys.add(sibling)
    state.claudeLeadStateByPaneKey.set(PANE, { state: 'working', stateStartedAt: 1 })
    state.codexLeadStateByPaneKey.set(PANE, { state: 'working', stateStartedAt: 1 })
    state.grokActiveTurnByPaneKey.set(PANE, { promptId: 'prompt-1' })

    clearPaneCacheState(state, PANE)

    for (const map of paneMaps) {
      const cache = map as Map<string, unknown>
      expect(cache.has(PANE)).toBe(false)
      expect(cache.has(scoped)).toBe(false)
      expect(cache.get(sibling)).toBe('sibling')
    }
    expect(state.lastStatusByPaneKey.has(PANE)).toBe(false)
    expect(state.lastStatusByPaneKey.has(scoped)).toBe(false)
    expect(state.lastStatusByPaneKey.get(sibling)?.payload.prompt).toBe('sibling')
    expect(state.ampCompletedCacheKeys.has(scoped)).toBe(false)
    expect(state.ampCompletedCacheKeys.has(PANE)).toBe(false)
    expect(state.ampCompletedCacheKeys.has(sibling)).toBe(true)
    expect(state.claudeLeadStateByPaneKey.has(PANE)).toBe(false)
    expect(state.codexLeadStateByPaneKey.has(PANE)).toBe(false)
    expect(state.grokActiveTurnByPaneKey.has(PANE)).toBe(false)
  })

  it('preserves cache mutation from a provider reset that emits no row', () => {
    const state = createHookListenerState()
    state.lastPromptByPaneKey.set(PANE, 'old prompt')
    state.lastToolByPaneKey.set(PANE, { toolName: 'old tool' })
    seedLegacyAgentStatusForTests(state, {
      paneKey: PANE,
      connectionId: null,
      payload: { state: 'working', prompt: 'old status' }
    })

    const event = normalizeHookPayload(
      state,
      'droid',
      { paneKey: PANE, payload: { hook_event_name: 'SessionStart' } },
      'production'
    )

    expect(event).toBeNull()
    expect(state.lastPromptByPaneKey.has(PANE)).toBe(false)
    expect(state.lastToolByPaneKey.has(PANE)).toBe(false)
    expect(state.lastStatusByPaneKey.has(PANE)).toBe(true)
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
