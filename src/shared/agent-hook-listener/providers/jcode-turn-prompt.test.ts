import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JcodeUserPromptEvidence } from '../../jcode-session-files'

const { readMock } = vi.hoisted(() => ({
  readMock: vi.fn<() => JcodeUserPromptEvidence | null>()
}))
vi.mock('../../jcode-session-files', () => ({
  readLastJcodeUserPromptFromHookPayload: readMock
}))

import { createHookListenerState, type HookListenerState } from '../listener-state'
import { readJcodeTurnPrompt } from './jcode-turn-prompt'

const PAYLOAD = { session_id: 'session_jc_9' }

// jcode blocks on pre_tool; repeated synchronous transcript scans add latency to every tool.
describe('jcode turn prompt cache', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
    readMock.mockReset()
    readMock.mockReturnValue({ text: 'ship it', interactionKey: 'k1' })
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
    const first = readJcodeTurnPrompt(state, 'turn_start', 'pane-a', PAYLOAD)
    expect(first).toEqual({ text: 'ship it', interactionKey: 'k1' })
    const next = { text: 'review the release', interactionKey: 'k2' }
    readMock.mockReturnValue(next)
    expect(readJcodeTurnPrompt(state, 'pre_tool', 'pane-a', PAYLOAD)).toEqual(first)
    expect(readJcodeTurnPrompt(state, 'turn_start', 'pane-a', PAYLOAD)).toEqual(next)
    expect(readJcodeTurnPrompt(state, 'post_tool', 'pane-a', PAYLOAD)).toEqual(next)
    expect(readMock).toHaveBeenCalledTimes(2)
  })

  it('caches per pane, so one pane cannot answer for another', () => {
    const paneA = { text: 'ship it', interactionKey: 'k1' }
    const paneB = { text: 'review the release', interactionKey: 'k2' }
    const payloadB = { session_id: 'session_jc_10' }
    readMock.mockReturnValueOnce(paneA).mockReturnValueOnce(paneB)
    expect(readJcodeTurnPrompt(state, 'pre_tool', 'pane-a', PAYLOAD)).toEqual(paneA)
    expect(readJcodeTurnPrompt(state, 'pre_tool', 'pane-b', payloadB)).toEqual(paneB)
    expect(readJcodeTurnPrompt(state, 'post_tool', 'pane-a', PAYLOAD)).toEqual(paneA)
    expect(readJcodeTurnPrompt(state, 'post_tool', 'pane-b', payloadB)).toEqual(paneB)
    expect(readMock).toHaveBeenCalledTimes(2)
  })

  it('caches a miss, so a session with no recoverable prompt is not rescanned', () => {
    readMock.mockReturnValue(null)
    expect(readJcodeTurnPrompt(state, 'pre_tool', 'pane-a', PAYLOAD)).toBeNull()
    expect(readJcodeTurnPrompt(state, 'post_tool', 'pane-a', PAYLOAD)).toBeNull()
    expect(readMock).toHaveBeenCalledTimes(1)
  })
})
