import { describe, expect, it, vi } from 'vitest'

import { normalizeHookPayload } from './agent-hook-listener'
import {
  clearAllListenerCaches,
  clearPaneCacheState,
  createHookListenerState,
  movePaneCacheState
} from './agent-hook-listener/listener-state'
import { warnOnHookEnvOrVersionMismatch } from './agent-hook-listener/listener-limits'
import { resolveHookSource } from './agent-hook-listener/source-routing'
import { makePaneKey } from './stable-pane-id'

const PANE = makePaneKey('tab-hooks', '11111111-1111-4111-8112-111111111111')
const MOVED_PANE = makePaneKey('tab-hooks', '22222222-2222-4222-8222-222222222222')
const ROUTES = {
  '/hook/claude': 'claude',
  '/hook/codex': 'codex',
  '/hook/gemini': 'gemini',
  '/hook/antigravity': 'antigravity',
  '/hook/amp': 'amp',
  '/hook/opencode': 'opencode',
  '/hook/mimo-code': 'mimo-code',
  '/hook/cursor': 'cursor',
  '/hook/pi': 'pi',
  '/hook/omp': 'omp',
  '/hook/prime-agent': 'prime-agent',
  '/hook/droid': 'droid',
  '/hook/command-code': 'command-code',
  '/hook/grok': 'grok',
  '/hook/copilot': 'copilot',
  '/hook/hermes': 'hermes',
  '/hook/devin': 'devin',
  '/hook/kimi': 'kimi'
} as const
function normalizeProviderState(
  source: (typeof ROUTES)[keyof typeof ROUTES],
  eventName: string,
  payload: Record<string, unknown> = {}
) {
  return (
    normalizeHookPayload(
      createHookListenerState(),
      source,
      { paneKey: PANE, hook_event_name: eventName, payload },
      'production'
    )?.payload ?? null
  )
}
describe('agent hook extraction boundaries', () => {
  it('routes exactly the complete provider vocabulary', () => {
    for (const [pathname, source] of Object.entries(ROUTES)) {
      expect(resolveHookSource(pathname)).toBe(source)
      expect(resolveHookSource(`${pathname}/`)).toBeNull()
      expect(resolveHookSource(`${pathname}?v=1`)).toBeNull()
      expect(resolveHookSource(pathname.toUpperCase())).toBeNull()
    }
    expect(resolveHookSource('/hook/unknown')).toBeNull()
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

  it('warns before tab rejection and caps version and environment warning keys independently', () => {
    const orderState = createHookListenerState()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const rejected = normalizeHookPayload(
      orderState,
      'devin',
      {
        paneKey: PANE,
        tabId: 'wrong-tab',
        version: 'outdated',
        payload: { hook_event_name: 'UnknownEvent' }
      },
      'production'
    )
    expect(rejected).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)

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
    warn.mockRestore()
  })

  it('moves every pane-owned collection and preserves NUL suffixes', () => {
    const state = createHookListenerState()
    const scoped = `${PANE}\0child`
    const movedScoped = `${MOVED_PANE}\0child`
    const sibling = `${PANE}-sibling`
    const paneMaps = [
      state.lastPromptByPaneKey,
      state.lastToolByPaneKey,
      state.lastStatusByPaneKey,
      state.antigravityCompletedTranscriptByPaneKey,
      state.claudeSubagentRosterByPaneKey,
      state.claudeLeadStateByPaneKey,
      state.codexSubagentRosterByPaneKey,
      state.codexSubagentTranscriptByPaneKey,
      state.codexLeadStateByPaneKey
    ]
    for (const map of paneMaps) {
      const cache = map as Map<string, unknown>
      cache.set(PANE, 'exact')
      cache.set(scoped, 'scoped')
      cache.set(sibling, 'sibling')
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
    }
    for (const set of paneSets) {
      expect(set.has(MOVED_PANE)).toBe(true)
      expect(set.has(movedScoped)).toBe(true)
      expect(set.has(sibling)).toBe(true)
      expect(set.has(PANE)).toBe(false)
    }

    movePaneCacheState(state, MOVED_PANE, MOVED_PANE)
    expect((state.lastPromptByPaneKey as Map<string, unknown>).get(MOVED_PANE)).toBe('exact')
  })

  it('clears exact and NUL-scoped cache keys but not sibling prefixes', () => {
    const state = createHookListenerState()
    const scoped = `${PANE}\0thread`
    const sibling = `${PANE}-sibling`
    const paneMaps = [
      state.lastPromptByPaneKey,
      state.lastToolByPaneKey,
      state.lastStatusByPaneKey,
      state.antigravityCompletedTranscriptByPaneKey
    ]
    for (const map of paneMaps) {
      const cache = map as Map<string, unknown>
      cache.set(PANE, 'exact')
      cache.set(scoped, 'scoped')
      cache.set(sibling, 'sibling')
    }
    state.ampCompletedCacheKeys.add(PANE)
    state.ampCompletedCacheKeys.add(scoped)
    state.ampCompletedCacheKeys.add(sibling)
    state.claudeLeadStateByPaneKey.set(PANE, { state: 'working' })
    state.codexLeadStateByPaneKey.set(PANE, { state: 'working' })

    clearPaneCacheState(state, PANE)

    for (const map of paneMaps) {
      const cache = map as Map<string, unknown>
      expect(cache.has(PANE)).toBe(false)
      expect(cache.has(scoped)).toBe(false)
      expect(cache.get(sibling)).toBe('sibling')
    }
    expect(state.ampCompletedCacheKeys.has(scoped)).toBe(false)
    expect(state.ampCompletedCacheKeys.has(sibling)).toBe(true)
    expect(state.claudeLeadStateByPaneKey.has(PANE)).toBe(false)
    expect(state.codexLeadStateByPaneKey.has(PANE)).toBe(false)
  })

  it('preserves cache mutation from a provider reset that emits no row', () => {
    const state = createHookListenerState()
    state.lastPromptByPaneKey.set(PANE, 'old prompt')
    state.lastToolByPaneKey.set(PANE, { toolName: 'old tool' })
    state.lastStatusByPaneKey.set(PANE, {} as never)

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
    state.codexLeadStateByPaneKey.set(PANE, { state: 'working' })

    clearAllListenerCaches(state)

    expect(state.warnedVersions.size).toBe(0)
    expect(state.warnedEnvs.size).toBe(0)
    expect(state.lastPromptByPaneKey.size).toBe(0)
    expect(state.claudeRunningNonAgentTaskPaneKeys.size).toBe(0)
    expect(state.codexLeadStateByPaneKey.size).toBe(0)
  })
})
