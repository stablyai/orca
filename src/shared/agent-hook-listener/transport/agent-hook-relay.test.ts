import { describe, expect, it } from 'vitest'
import { createShedSubagentsField, restoreShedStatusFields } from './agent-hook-relay'
import type { ParsedAgentStatusPayload } from '../../agent-status/contracts/agent-status-types'

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

  it('does not overwrite a roster the envelope still carries', () => {
    const freshRoster = [
      { id: 'child-fresh', agentType: 'reviewer', state: 'working' as const, startedAt: 2 }
    ]
    const fresh: ParsedAgentStatusPayload = { ...shed, subagents: freshRoster }
    const restored = restoreShedStatusFields(fresh, [createShedSubagentsField(roster)], cached)
    expect(restored.subagents).toEqual(freshRoster)
  })
})
