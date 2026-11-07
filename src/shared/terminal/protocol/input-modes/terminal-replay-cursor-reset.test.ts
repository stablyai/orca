import { describe, expect, it } from 'vitest'
import {
  buildPostReplayLiveAgentReattachReset,
  POST_REPLAY_LIVE_AGENT_REATTACH_RESET,
  replayPayloadEndsWithCursorHidden,
  RESET_TERMINAL_CURSOR_STYLE
} from './terminal-mode-reset-profiles'

describe('replayPayloadEndsWithCursorHidden', () => {
  it('is true when the last DECTCEM sequence hides the cursor', () => {
    expect(replayPayloadEndsWithCursorHidden('\x1b[?25h frame \x1b[?25l')).toBe(true)
    expect(replayPayloadEndsWithCursorHidden('\x1b[?1004h\x1b[?25lparked screen')).toBe(true)
  })

  it('is false when the cursor was re-shown or never touched', () => {
    expect(replayPayloadEndsWithCursorHidden('\x1b[?25l frame \x1b[?25h')).toBe(false)
    expect(replayPayloadEndsWithCursorHidden('plain shell output')).toBe(false)
    expect(replayPayloadEndsWithCursorHidden('')).toBe(false)
  })
})

describe('buildPostReplayLiveAgentReattachReset', () => {
  it('preserves an intentionally hidden cursor', () => {
    expect(buildPostReplayLiveAgentReattachReset('agent frame\x1b[?25l')).toBe(
      RESET_TERMINAL_CURSOR_STYLE
    )
  })

  it('re-shows the cursor when the payload left it visible', () => {
    expect(buildPostReplayLiveAgentReattachReset('agent frame\x1b[?25l\x1b[?25h')).toBe(
      POST_REPLAY_LIVE_AGENT_REATTACH_RESET
    )
    expect(buildPostReplayLiveAgentReattachReset('no dectcem at all')).toBe(
      POST_REPLAY_LIVE_AGENT_REATTACH_RESET
    )
  })
})
