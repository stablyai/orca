// A Stop the host could not save, and a card's Cancel whose dismissal it could not save: each
// says so in its own plain words.

import { describe, expect, it } from 'vitest'
import {
  agentSessionRefusalNotice,
  agentSessionWriteNoticeEnglish,
  agentSessionWriteNoticeParts
} from './agent-session-refusal-notice'
import { agentSessionRefusalFailure } from './agent-session-write-failure'

const HOST_TEXT = 'Expected runtime fence 1; the session is at 3.'

describe('a Stop the host could not save or carry out', () => {
  const stopFailed = (details: unknown) =>
    agentSessionRefusalFailure(
      JSON.parse(JSON.stringify({ code: 'agent_session_operation_invalid', details }))
    )

  it('names the agent and says to try again', () => {
    expect(
      agentSessionRefusalNotice(
        {
          code: 'agent_session_operation_invalid',
          message: HOST_TEXT,
          details: { reason: 'stopFailed', agent: 'codex' }
        },
        'stop'
      )
    ).toBe("Couldn't stop Codex. Try again.")
    expect(
      agentSessionWriteNoticeEnglish(
        agentSessionWriteNoticeParts(stopFailed({ reason: 'stopFailed' }), 'stop')
      )
    ).toBe("Couldn't stop the agent. Try again.")
    // A newer host's agent reads as none.
    expect(
      agentSessionWriteNoticeEnglish(
        agentSessionWriteNoticeParts(
          stopFailed({ reason: 'stopFailed', agent: 'fromTheFuture' }),
          'stop'
        )
      )
    ).toBe("Couldn't stop the agent. Try again.")
  })

  it('leaves out trying again beside a Retry, and keeps the code words on any other write', () => {
    const failure = stopFailed({ reason: 'stopFailed', agent: 'claude' })
    expect(
      agentSessionWriteNoticeEnglish(
        agentSessionWriteNoticeParts(failure, 'stop', { retryControl: true })
      )
    ).toBe("Couldn't stop Claude.")
    expect(agentSessionWriteNoticeParts(failure, 'stop-task')).toEqual(['notDoneStopTask'])
  })

  it("says a card's Cancel that could not be saved left the card, never that the agent didn't stop", () => {
    expect(
      agentSessionRefusalNotice(
        {
          code: 'agent_session_operation_invalid',
          message: HOST_TEXT,
          details: { reason: 'cancelNotSaved' }
        },
        'stop'
      )
    ).toBe("This question or approval wasn't cancelled.")
  })

  // A client from before the reason keeps only reasons it lists: it reads none, and the code's words.
  it('reads on a client that predates it as the Stop that did not happen', () => {
    const refusal = JSON.parse(
      JSON.stringify({
        code: 'agent_session_operation_invalid',
        message: HOST_TEXT,
        details: { reason: 'aReasonThisClientLacks', agent: 'codex' }
      })
    )
    expect(agentSessionRefusalNotice(refusal, 'stop')).toBe("The agent wasn't stopped.")
  })
})
