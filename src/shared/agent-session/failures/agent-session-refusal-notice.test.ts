import { describe, expect, it } from 'vitest'
import {
  agentSessionRefusalCauseParts,
  agentSessionWriteNoticeEnglish
} from './agent-session-refusal-notice'
import { agentSessionFailureSentence } from './agent-session-failure-words'
import {
  agentSessionRefusalFailure,
  parseAgentSessionWriteFailure
} from './agent-session-write-failure'

describe('agentSessionRefusalCauseParts', () => {
  it.each(['managed', 'system'] as const)(
    'retains the %s account when saving a refused message',
    (account) => {
      const refusal = {
        code: 'agent_session_operation_invalid',
        details: { reason: 'notSignedIn', account }
      } as const
      const saved = agentSessionRefusalFailure(refusal)
      expect(saved.details).toEqual(refusal.details)
      const parts = agentSessionRefusalCauseParts(saved, { agentName: 'Claude' })
      expect(agentSessionWriteNoticeEnglish(parts)).toBe(
        agentSessionFailureSentence({ kind: 'notSignedIn', account }, 'rejection', {
          agentName: 'Claude'
        })
      )
    }
  )
})

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
