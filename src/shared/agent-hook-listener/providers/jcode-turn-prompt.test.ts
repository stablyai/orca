import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readMock } = vi.hoisted(() => ({
  readMock: vi.fn(() => ({ text: 'ship it', interactionKey: 'k1' }))
}))
vi.mock('../../jcode-session-files', () => ({
  readLastJcodeUserPromptFromHookPayload: readMock
}))

import { createHookListenerState, type HookListenerState } from '../listener-state'
import { readJcodeTurnPrompt } from './jcode-turn-prompt'

const PAYLOAD = { session_id: 'session_jc_9' }

// Why this is worth a test: the read is a synchronous file scan and jcode blocks on
// pre_tool, so one repeated per tool call is latency the user pays on every tool.
describe('jcode turn prompt cache', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
    readMock.mockClear()
  })

  it('reads the journal once per turn, not once per tool', () => {
    readJcodeTurnPrompt(state, 'turn_start', 'pane-a', PAYLOAD)
    for (let call = 0; call < 4; call += 1) {
      readJcodeTurnPrompt(state, 'pre_tool', 'pane-a', PAYLOAD)
      readJcodeTurnPrompt(state, 'post_tool', 'pane-a', PAYLOAD)
    }
    expect(readJcodeTurnPrompt(state, 'turn_end', 'pane-a', PAYLOAD)).toEqual({
      text: 'ship it',
      interactionKey: 'k1'
    })
    expect(readMock).toHaveBeenCalledTimes(1)
  })

  it('re-reads on the next turn, so a new prompt is not served from the old turn', () => {
    readJcodeTurnPrompt(state, 'turn_start', 'pane-a', PAYLOAD)
    readJcodeTurnPrompt(state, 'pre_tool', 'pane-a', PAYLOAD)
    readJcodeTurnPrompt(state, 'turn_start', 'pane-a', PAYLOAD)
    expect(readMock).toHaveBeenCalledTimes(2)
  })

  it('caches per pane, so one pane cannot answer for another', () => {
    readJcodeTurnPrompt(state, 'pre_tool', 'pane-a', PAYLOAD)
    readJcodeTurnPrompt(state, 'pre_tool', 'pane-b', PAYLOAD)
    expect(readMock).toHaveBeenCalledTimes(2)
  })

  it('caches a miss, so a session with no recoverable prompt is not rescanned', () => {
    // @ts-expect-error -- the reader returns null when no journal prompt exists.
    readMock.mockReturnValue(null)
    expect(readJcodeTurnPrompt(state, 'pre_tool', 'pane-a', PAYLOAD)).toBeNull()
    expect(readJcodeTurnPrompt(state, 'post_tool', 'pane-a', PAYLOAD)).toBeNull()
    expect(readMock).toHaveBeenCalledTimes(1)
  })
})
