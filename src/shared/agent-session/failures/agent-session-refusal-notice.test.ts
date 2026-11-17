import { describe, expect, it } from 'vitest'
import { agentSessionRefusalCauseParts } from './agent-session-refusal-notice'
import './agent-session-failure-words'
import './agent-session-refusal-details'
import {
  agentSessionRefusalFailure,
  parseAgentSessionWriteFailure
} from './agent-session-write-failure'

describe('saved Arguments refusals', () => {
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

it('says a conversation from another folder was saved there, not that its history is unavailable', () => {
  const failure = agentSessionRefusalFailure({
    code: 'agent_session_identity_required',
    details: { reason: 'transcriptUnreadable', otherFolder: true }
  })
  expect(agentSessionRefusalCauseParts(failure)).toEqual(['savedInOtherFolder'])
})
