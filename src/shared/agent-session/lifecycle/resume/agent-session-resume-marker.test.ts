import { describe, expect, it } from 'vitest'
import {
  parseAgentSessionResumeMarker,
  storedAgentSessionResumeMarker,
  type AgentSessionResumeMarker
} from './agent-session-resume-marker'
import { restartActivityWaitsOnPerson } from '../stopping/agent-session-restart-activity'

const marker: AgentSessionResumeMarker = {
  sessionId: 's1',
  work: { kind: 'turn', id: 't1' },
  recordedAt: 10,
  trigger: 'crash',
  providerHandleRoot: 'root',
  teardownId: 'td',
  exitUnproven: true,
  activity: { state: 'working', prompts: [], tasks: [{ kind: 'agent', label: 'a' }] }
}

describe('exitUnproven resume marker storage', () => {
  it('blocks automatic resume on older builds and restores the original activity', () => {
    const stored = storedAgentSessionResumeMarker(marker)

    expect(stored.trigger).toBe('quit')
    expect(restartActivityWaitsOnPerson(stored.activity)).toBe(true)
    expect(parseAgentSessionResumeMarker(stored)).toEqual(marker)
  })
})

describe('exitUnproven activity round trip', () => {
  it('keeps a blocked activity without prompts blocked', () => {
    const blocked = { ...marker, activity: { state: 'blocked' as const, prompts: [], tasks: [] } }

    expect(parseAgentSessionResumeMarker(storedAgentSessionResumeMarker(blocked))).toEqual(blocked)
  })

  it('keeps an absent activity absent', () => {
    const { activity: _activity, ...bare } = marker

    expect(parseAgentSessionResumeMarker(storedAgentSessionResumeMarker(bare))).toEqual(bare)
  })
})
