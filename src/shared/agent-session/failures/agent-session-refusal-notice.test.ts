import { describe, expect, it } from 'vitest'
import {
  agentSessionRefusalCauseParts,
  agentSessionWriteNoticeEnglish
} from './agent-session-refusal-notice'
import './agent-session-failure-words'
import './agent-session-refusal-details'
import {
  agentSessionRefusalFailure,
  parseAgentSessionWriteFailure
} from './agent-session-write-failure'

describe('saved Arguments refusals', () => {
  it('keeps the validated cause after durable parsing and names the correction beside Retry', () => {
    const refused = agentSessionRefusalFailure({
      code: 'agent_session_operation_invalid',
      details: {
        reason: 'attachFailed',
        argumentProblem: { agent: 'Codex', option: '--remote', problem: 'unsupportedOption' }
      }
    })
    const parsed = parseAgentSessionWriteFailure(JSON.parse(JSON.stringify(refused)))
    if (!parsed) {
      throw new Error('saved refusal was not read')
    }
    expect(agentSessionWriteNoticeEnglish(agentSessionRefusalCauseParts(parsed))).toBe(
      "Codex couldn't start. Saved Arguments contain an unsupported option (--remote). Edit them in Settings > Agents > Arguments."
    )
  })

  it.each([
    { agent: 'Codex', option: '--remote', problem: 'futureProblem' },
    { agent: 'Codex', option: '--remote=private', problem: 'unsupportedOption' }
  ])('ignores an unrecognized or unsafe argument detail', (argumentProblem) => {
    const refused = parseAgentSessionWriteFailure({
      kind: 'refused',
      code: 'agent_session_operation_invalid',
      details: { reason: 'attachFailed', argumentProblem }
    })
    expect(refused).toEqual({
      kind: 'refused',
      code: 'agent_session_operation_invalid',
      details: { reason: 'attachFailed' }
    })
    if (!refused) {
      throw new Error('refusal was not read')
    }
    expect(agentSessionRefusalCauseParts(refused)).toEqual([])
  })
})
