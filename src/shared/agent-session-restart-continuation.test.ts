import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_RESTART_CONTINUATION_MESSAGE,
  AGENT_SESSION_RESTART_WORK_CONTINUATION_MESSAGE,
  restartContinuationMessage
} from './agent-session-restart-continuation'

describe('the restart continuation message', () => {
  it('keeps the original wording for a marker from a build that recorded only a working lead', () => {
    expect(restartContinuationMessage({})).toBe(AGENT_SESSION_RESTART_CONTINUATION_MESSAGE)
  })

  // The fingerprint covers the body, so it may depend on nothing the journal can restate.
  it('covers every kind of stopped work for a marker that carries a snapshot', () => {
    expect(
      restartContinuationMessage({ activity: { state: 'working', prompts: [], tasks: [] } })
    ).toBe(AGENT_SESSION_RESTART_WORK_CONTINUATION_MESSAGE)
  })
})
