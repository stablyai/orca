import { describe, expect, it } from 'vitest'
import { isCommandCodeNewTurnWhileWorking } from './command-code-turn-boundary'

describe('isCommandCodeNewTurnWhileWorking', () => {
  it('returns true when Command Code gets a new transcript prompt while still working', () => {
    expect(
      isCommandCodeNewTurnWhileWorking({
        agentType: 'command-code',
        previousState: 'working',
        incomingState: 'working',
        previousPrompt: 'first task',
        incomingPrompt: 'second task',
        hasExplicitPrompt: true
      })
    ).toBe(true)
  })

  it('returns true when the prompt interaction key changes', () => {
    expect(
      isCommandCodeNewTurnWhileWorking({
        agentType: 'command-code',
        previousState: 'working',
        incomingState: 'working',
        previousPrompt: 'same text',
        incomingPrompt: 'same text',
        hasExplicitPrompt: true,
        previousPromptInteractionKey: 'command-code-transcript-a',
        incomingPromptInteractionKey: 'command-code-transcript-b'
      })
    ).toBe(true)
  })

  it('returns false for same-turn tool pings that keep the same prompt', () => {
    expect(
      isCommandCodeNewTurnWhileWorking({
        agentType: 'command-code',
        previousState: 'working',
        incomingState: 'working',
        previousPrompt: 'run pwd',
        incomingPrompt: 'run pwd',
        hasExplicitPrompt: true
      })
    ).toBe(false)
  })

  it('returns false when main-process hooks explicitly deny prompt evidence', () => {
    expect(
      isCommandCodeNewTurnWhileWorking({
        agentType: 'command-code',
        previousState: 'working',
        incomingState: 'working',
        previousPrompt: 'first',
        incomingPrompt: 'second',
        hasExplicitPrompt: false
      })
    ).toBe(false)
  })

  it('returns false for non-Command Code agents', () => {
    expect(
      isCommandCodeNewTurnWhileWorking({
        agentType: 'codex',
        previousState: 'working',
        incomingState: 'working',
        previousPrompt: 'first',
        incomingPrompt: 'second',
        hasExplicitPrompt: true
      })
    ).toBe(false)
  })
})
