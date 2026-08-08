import { describe, expect, it } from 'vitest'
import {
  AGENT_HOOK_INSTALL_PLUGINS_METHOD,
  AGENT_HOOK_NOTIFICATION_METHOD,
  AGENT_HOOK_REQUEST_REPLAY_METHOD,
  AGENT_HOOK_SHED_FIELDS_KEY,
  ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV,
  createShedSubagentsField,
  isAgentHookSource,
  isRemoteAgentHooksEnabled,
  restoreShedStatusFields,
  type AgentHookRelayEnvelope
} from './agent-hook-relay'
import type { ParsedAgentStatusPayload } from './agent-status-types'

describe('agent-hook-relay wire shape', () => {
  it('encodes/decodes through JSON without losing fields', () => {
    const envelope: AgentHookRelayEnvelope = {
      source: 'claude',
      paneKey: 'tab-1:0',
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: null,
      env: 'production',
      version: '1',
      providerPromptId: '11111111-1111-4111-8111-111111111111',
      compactTrigger: 'manual',
      payload: {
        state: 'working',
        prompt: 'roundtrip',
        agentType: 'claude'
      }
    }

    const decoded = JSON.parse(JSON.stringify(envelope)) as AgentHookRelayEnvelope
    expect(decoded).toEqual(envelope)
    expect(decoded.connectionId).toBeNull()
    expect(decoded.payload.prompt).toBe('roundtrip')
  })

  it('exposes stable JSON-RPC method names', () => {
    expect(AGENT_HOOK_NOTIFICATION_METHOD).toBe('agent.hook')
    expect(AGENT_HOOK_REQUEST_REPLAY_METHOD).toBe('agent_hook.requestReplay')
    expect(AGENT_HOOK_INSTALL_PLUGINS_METHOD).toBe('agent_hook.installPlugins')
  })

  it('validates hook sources crossing persisted and relay trust boundaries', () => {
    expect(isAgentHookSource('claude')).toBe(true)
    expect(isAgentHookSource('kimi')).toBe(true)
    expect(isAgentHookSource('claude\0codex')).toBe(false)
    expect(isAgentHookSource('unknown')).toBe(false)
    expect(isAgentHookSource({ source: 'claude' })).toBe(false)
  })
})

describe('isRemoteAgentHooksEnabled', () => {
  it('is on when the env var is absent', () => {
    expect(isRemoteAgentHooksEnabled({})).toBe(true)
  })

  it('is off for empty / "0"', () => {
    expect(isRemoteAgentHooksEnabled({ [ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV]: '' })).toBe(false)
    expect(isRemoteAgentHooksEnabled({ [ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV]: '0' })).toBe(false)
    expect(isRemoteAgentHooksEnabled({ [ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV]: '   ' })).toBe(false)
  })

  it('is on for any other non-empty value', () => {
    expect(isRemoteAgentHooksEnabled({ [ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV]: '1' })).toBe(true)
    expect(isRemoteAgentHooksEnabled({ [ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV]: 'on' })).toBe(true)
    expect(isRemoteAgentHooksEnabled({ [ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV]: 'true' })).toBe(true)
  })
})

describe('restoreShedStatusFields', () => {
  const roster = [{ id: 'child-1', agentType: 'reviewer', state: 'working' as const, startedAt: 1 }]
  const cached: ParsedAgentStatusPayload = {
    state: 'working',
    prompt: 'p',
    agentType: 'claude',
    subagents: roster,
    lastAssistantMessage: 'cached message',
    interactivePrompt: '{"questions":["old"]}'
  }
  const shed: ParsedAgentStatusPayload = { state: 'done', prompt: 'p', agentType: 'claude' }

  it('restores a matching shed roster, so a done pane is not falsely hibernation-eligible', () => {
    const restored = restoreShedStatusFields(shed, [createShedSubagentsField(roster)], cached)
    expect(restored.subagents).toEqual(roster)
    expect(restored.state).toBe('done')
    // Only the named field comes back.
    expect(restored.lastAssistantMessage).toBeUndefined()
  })

  it('does not restore a shed roster across a prompt identity change', () => {
    expect(AGENT_HOOK_SHED_FIELDS_KEY).toBe('shedFields')
    const nextTurn = { ...shed, prompt: 'next prompt' }
    const restored = restoreShedStatusFields(
      nextTurn,
      ['lastAssistantMessage', createShedSubagentsField(roster)],
      cached
    )
    expect(restored.lastAssistantMessage).toBeUndefined()
    expect(restored.subagents).toBeUndefined()
    expect(restored).toBe(nextTurn)
  })

  it('does not restore the cached roster when the shed roster digest changed', () => {
    const changedRoster = [
      { id: 'child-2', agentType: 'reviewer', state: 'working' as const, startedAt: 2 }
    ]
    const restored = restoreShedStatusFields(
      shed,
      [createShedSubagentsField(changedRoster)],
      cached
    )
    expect(restored.subagents).toBeUndefined()
    expect(restored).toBe(shed)
  })

  it('never restores interactivePrompt — a stale answerable card is worse than none', () => {
    const restored = restoreShedStatusFields(shed, ['interactivePrompt'], cached)
    expect(restored.interactivePrompt).toBeUndefined()
    expect(restored).toBe(shed)
  })

  it('leaves an intentional lastAssistantMessage clear intact when the relay shed nothing', () => {
    expect(restoreShedStatusFields(shed, undefined, cached)).toBe(shed)
    expect(restoreShedStatusFields(shed, [], cached)).toBe(shed)
    expect(restoreShedStatusFields(shed, [], cached).lastAssistantMessage).toBeUndefined()
    // A hostile/garbled marker must not throw or restore.
    expect(restoreShedStatusFields(shed, 'subagents', cached)).toBe(shed)
    expect(restoreShedStatusFields(shed, ['subagents'], cached)).toBe(shed)
    expect(restoreShedStatusFields(shed, [{ toString: () => 'subagents' }], cached)).toBe(shed)
  })

  it('does not overwrite a value the envelope still carries', () => {
    const fresh: ParsedAgentStatusPayload = { ...shed, lastAssistantMessage: 'fresh' }
    expect(
      restoreShedStatusFields(fresh, ['lastAssistantMessage'], cached).lastAssistantMessage
    ).toBe('fresh')
  })

  it('is a no-op with no cached payload for the pane', () => {
    expect(restoreShedStatusFields(shed, ['subagents'], undefined)).toBe(shed)
  })
})
