import { describe, expect, it } from 'vitest'
import {
  ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV,
  createShedSubagentsField,
  isAgentHookSource,
  isWslAgentHookRelayEnabled,
  restoreShedStatusFields
} from './agent-hook-relay'
import { normalizeAgentStatusPayload, type ParsedAgentStatusPayload } from './agent-status-types'
import { dolphinHooks } from './agent-hook-listener-jcode-swarm-fixtures'

describe('agent-hook-relay wire shape', () => {
  it('validates hook sources crossing persisted and relay trust boundaries', () => {
    expect(isAgentHookSource('claude')).toBe(true)
    expect(isAgentHookSource('kimi')).toBe(true)
    expect(isAgentHookSource('prime-agent')).toBe(true)
    expect(isAgentHookSource('claude\0codex')).toBe(false)
    expect(isAgentHookSource('unknown')).toBe(false)
    expect(isAgentHookSource({ source: 'claude' })).toBe(false)
  })
})

describe('isWslAgentHookRelayEnabled', () => {
  it('is on when the env var is absent', () => {
    expect(isWslAgentHookRelayEnabled({})).toBe(true)
  })

  it('is off for empty / "0"', () => {
    expect(isWslAgentHookRelayEnabled({ [ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV]: '' })).toBe(false)
    expect(isWslAgentHookRelayEnabled({ [ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV]: '0' })).toBe(false)
    expect(isWslAgentHookRelayEnabled({ [ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV]: '   ' })).toBe(false)
    expect(isWslAgentHookRelayEnabled({ [ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV]: ' 0 ' })).toBe(false)
  })

  it('is on for any other non-empty value', () => {
    expect(isWslAgentHookRelayEnabled({ [ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV]: '1' })).toBe(true)
    expect(isWslAgentHookRelayEnabled({ [ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV]: 'on' })).toBe(true)
    expect(isWslAgentHookRelayEnabled({ [ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV]: 'true' })).toBe(true)
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

  it('keeps the exact old-reader digest for snapshots without reports', () => {
    expect(createShedSubagentsField(roster)).toBe(
      'subagents:sha256:q6uU3y9CE7oWyfGIMoSw8d2KpJiKSCHi2J6j9-XIwEk'
    )
    expect(createShedSubagentsField([{ ...roster[0], lastAssistantMessage: undefined }])).toBe(
      createShedSubagentsField(roster)
    )
  })

  it('round-trips a child report and accepts its snapshot on an old reader', () => {
    const { message } = JSON.parse(dolphinHooks[4].tool_input)
    const subagents = [
      {
        id: dolphinHooks[4].session_id,
        state: 'idle' as const,
        startedAt: 10,
        agentType: 'octopus',
        model: dolphinHooks[3].model,
        lastAssistantMessage: message
      }
    ]
    const envelope = JSON.parse(
      JSON.stringify({
        source: 'jcode',
        paneKey: 'remote-pane',
        connectionId: null,
        payload: { ...cached, subagents }
      })
    )
    const received = normalizeAgentStatusPayload(envelope.payload)
    expect(received?.subagents).toEqual(subagents)
    const marker = createShedSubagentsField(subagents)
    expect(restoreShedStatusFields(shed, [marker], received ?? undefined).subagents).toEqual(
      subagents
    )
    // An old reader selects only its known fields and still accepts the child.
    const oldShape = subagents.map(({ lastAssistantMessage: _report, ...child }) => child)
    expect(normalizeAgentStatusPayload({ ...cached, subagents: oldShape })?.subagents).toEqual(
      oldShape
    )
  })

  it('refuses stale cached roster prose after a report-only update', () => {
    const { message } = JSON.parse(dolphinHooks[4].tool_input)
    const subagents = [{ ...roster[0], lastAssistantMessage: message }]
    const marker = createShedSubagentsField(subagents)
    expect(marker).not.toBe(createShedSubagentsField(roster))
    const changed = [{ ...subagents[0], lastAssistantMessage: 'updated report' }]
    expect(createShedSubagentsField(changed)).not.toBe(marker)
    expect(restoreShedStatusFields(shed, [marker], { ...cached, subagents: changed })).toBe(shed)
  })

  it('restores a matching shed roster, so a done pane is not falsely hibernation-eligible', () => {
    const restored = restoreShedStatusFields(shed, [createShedSubagentsField(roster)], cached)
    expect(restored.subagents).toEqual(roster)
    expect(restored.state).toBe('done')
    expect(restored.lastAssistantMessage).toBeUndefined()
  })

  it('does not restore a shed roster across a prompt identity change', () => {
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
    expect(restoreShedStatusFields(shed, 'subagents', cached)).toBe(shed)
    expect(restoreShedStatusFields(shed, ['subagents'], cached)).toBe(shed)
    expect(restoreShedStatusFields(shed, [{ toString: () => 'subagents' }], cached)).toBe(shed)
  })

  it('does not overwrite a roster the envelope still carries', () => {
    const freshRoster = [
      { id: 'child-fresh', agentType: 'reviewer', state: 'working' as const, startedAt: 2 }
    ]
    const fresh: ParsedAgentStatusPayload = { ...shed, subagents: freshRoster }
    const restored = restoreShedStatusFields(fresh, [createShedSubagentsField(roster)], cached)
    expect(restored.subagents).toEqual(freshRoster)
  })

  it('is a no-op with no cached payload for the pane', () => {
    expect(restoreShedStatusFields(shed, ['subagents'], undefined)).toBe(shed)
  })
})
