import { describe, expect, it } from 'vitest'
import {
  COLD_RESTORE_SEED_MODE_RESET,
  POST_REPLAY_LIVE_AGENT_REATTACH_RESET,
  POST_REPLAY_LIVE_AGENT_SNAPSHOT_RESET,
  POST_REPLAY_LIVE_SNAPSHOT_RESET,
  POST_REPLAY_MODE_RESET,
  POST_REPLAY_REATTACH_RESET,
  POST_REPLAY_REATTACH_RESET_KEEP_MOUSE,
  RESET_GRAPHIC_RENDITION,
  RESET_MOUSE_REPORTING,
  buildPostReplayLiveAgentReattachReset,
  replayPayloadEndsWithCursorHidden
} from './terminal-mode-reset-profiles'

// Why literal expectations: consumers import these constants, so only a byte-level
// assertion here can catch a profile silently losing a mode it is meant to clear.
describe('terminal mode reset profiles', () => {
  it('clears every mouse protocol and encoding a snapshot can re-arm', () => {
    expect(RESET_MOUSE_REPORTING).toBe(
      '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1016l'
    )
  })

  it('pins the fresh-shell profile', () => {
    expect(POST_REPLAY_MODE_RESET).toBe(
      '\x1b[0m\x1b[0 q\x1b[<99u\x1b[=0u\x1b[?25h\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1016l\x1b[?1004l\x1b[?2004l\x1b7'
    )
  })

  it('pins the daemon-reattach profile, which keeps bracketed paste', () => {
    expect(POST_REPLAY_REATTACH_RESET).toBe(
      '\x1b[0m\x1b[0 q\x1b[<99u\x1b[=0u\x1b[?25h\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1016l\x1b[?1004l\x1b7'
    )
    expect(POST_REPLAY_REATTACH_RESET).toContain(RESET_GRAPHIC_RENDITION)
    expect(POST_REPLAY_REATTACH_RESET).not.toContain('\x1b[?2004l')
  })

  // Why ?1004l stays: #944 — a hard-killed TUI leaves the daemon emulator on the alternate buffer,
  // so this profile can reach a plain shell, where armed focus reporting rings BEL on every pane
  // switch. Dropping it would also make this byte-identical to the live-agent profile.
  it('pins the live alternate-screen profile, which keeps mouse reporting but not focus', () => {
    expect(POST_REPLAY_REATTACH_RESET_KEEP_MOUSE).toBe(
      '\x1b[0 q\x1b[<99u\x1b[=0u\x1b[?25h\x1b[?1004l'
    )
    expect(POST_REPLAY_REATTACH_RESET_KEEP_MOUSE).not.toContain(RESET_MOUSE_REPORTING)
    expect(POST_REPLAY_REATTACH_RESET_KEEP_MOUSE).not.toBe(POST_REPLAY_LIVE_AGENT_REATTACH_RESET)
  })

  // Why: #12101 — a cold-restored seed re-arms mouse reporting for a dead TUI.
  it('clears the pen and disarms mouse reporting on the cold-restore seed', () => {
    expect(COLD_RESTORE_SEED_MODE_RESET).toBe(`${RESET_GRAPHIC_RENDITION}${RESET_MOUSE_REPORTING}`)
  })

  // Why: the seed also feeds the daemon emulator and is re-serialized from it, so
  // re-entering alt screen or resetting the cursor there would fight the renderer.
  it('keeps the cold-restore seed free of cursor, kitty and alt-screen bytes', () => {
    for (const forbidden of ['\x1b[0 q', '\x1b[<99u', '\x1b[?25h', '\x1b[?1049']) {
      expect(COLD_RESTORE_SEED_MODE_RESET).not.toContain(forbidden)
    }
  })

  // Why byte equality and not just `not.toContain`: a profile that lost every mode
  // would satisfy an absence assertion perfectly, so these two — whose only other
  // coverage asserts they were passed through unchanged — need a literal here.
  it('pins the live-snapshot and live-agent profiles', () => {
    expect(POST_REPLAY_LIVE_SNAPSHOT_RESET).toBe('\x1b[0 q\x1b[?25h\x1b[?1004l')
    expect(POST_REPLAY_LIVE_AGENT_REATTACH_RESET).toBe('\x1b[0 q\x1b[<99u\x1b[=0u\x1b[?25h')
    expect(POST_REPLAY_LIVE_AGENT_SNAPSHOT_RESET).toBe('\x1b[0 q')
  })

  it('leaves a live agent its focus reporting and bracketed paste', () => {
    for (const profile of [
      POST_REPLAY_LIVE_AGENT_REATTACH_RESET,
      POST_REPLAY_LIVE_AGENT_SNAPSHOT_RESET,
      POST_REPLAY_LIVE_SNAPSHOT_RESET
    ]) {
      expect(profile).not.toContain(RESET_GRAPHIC_RENDITION)
      expect(profile).not.toContain('\x1b[?1000l')
      expect(profile).not.toContain('\x1b[?2004l')
    }
    expect(POST_REPLAY_LIVE_AGENT_REATTACH_RESET).not.toContain('\x1b[?1004l')
  })

  describe('live-agent cursor preservation', () => {
    it('detects a payload that ends cursor-hidden', () => {
      expect(replayPayloadEndsWithCursorHidden('a\x1b[?25hb\x1b[?25lc')).toBe(true)
      expect(replayPayloadEndsWithCursorHidden('a\x1b[?25lb\x1b[?25hc')).toBe(false)
      expect(replayPayloadEndsWithCursorHidden('no modes here')).toBe(false)
    })

    it('omits the cursor-show when the agent left its cursor hidden', () => {
      expect(buildPostReplayLiveAgentReattachReset('x\x1b[?25l')).not.toContain('\x1b[?25h')
      expect(buildPostReplayLiveAgentReattachReset('x\x1b[?25h')).toContain('\x1b[?25h')
    })
  })
})
