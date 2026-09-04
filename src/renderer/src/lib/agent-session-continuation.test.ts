import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_CONTINUATION_PROMPT_LEAD,
  buildAgentSessionContinuationPrompt,
  isAgentSessionContinuationPrompt
} from './agent-session-continuation'

describe('isAgentSessionContinuationPrompt', () => {
  it('matches the Orca continuation prompt the builder emits', () => {
    const prompt = buildAgentSessionContinuationPrompt(
      {
        capturedText: 'User: keep going\nAssistant: editing the form',
        sourceAgent: 'grok'
      },
      'focused'
    )

    expect(prompt).toContain(AGENT_SESSION_CONTINUATION_PROMPT_LEAD)
    expect(isAgentSessionContinuationPrompt(prompt ?? '')).toBe(true)
  })

  it('ignores ordinary user prompts', () => {
    expect(isAgentSessionContinuationPrompt('Ship the picker search')).toBe(false)
    expect(
      isAgentSessionContinuationPrompt(
        `Please read this note.\n${AGENT_SESSION_CONTINUATION_PROMPT_LEAD}`
      )
    ).toBe(false)
  })
})
