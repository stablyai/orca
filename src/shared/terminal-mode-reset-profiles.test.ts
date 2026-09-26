import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import {
  POST_REPLAY_LIVE_AGENT_REATTACH_RESET,
  POST_REPLAY_LIVE_AGENT_SNAPSHOT_RESET,
  POST_REPLAY_LIVE_SNAPSHOT_RESET,
  POST_REPLAY_MODE_RESET,
  POST_REPLAY_REATTACH_RESET,
  POST_REPLAY_REATTACH_RESET_KEEP_MOUSE,
  PROCESS_BOUNDARY_GROUND,
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

  // Why: the one reset for a process boundary (cold-restore seed, proven crash).
  it('pins the process boundary ground', () => {
    expect(PROCESS_BOUNDARY_GROUND).toBe(
      '\x1b[<99u\x1b[=0u\x1b7\x1b[?1049l\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1016l\x1b[?1005l\x1b[?1015l\x1b[?1004l\x1b[?2004l\x1b[?1l\x1b[?66l\x1b[?25h\x1b[0 q\x1b[<99u\x1b[=0u\x1b[0m\x1b7'
    )
  })

  it("clears a dead TUI's alternate-screen kitty flags for the next alternate-screen app", async () => {
    const term = new Terminal({ allowProposedApi: true, vtExtensions: { kittyKeyboard: true } })
    const replies: string[] = []
    term.onData((data) => replies.push(data))
    const write = (data: string): Promise<void> =>
      new Promise((resolve) => term.write(data, resolve))
    await write(`\x1b[?1049h\x1b[>7u\x1b[>1u${PROCESS_BOUNDARY_GROUND}\x1b[?1049h`)
    // Query, then pop once and query again: an empty stack pops to 0.
    await write('\x1b[?u\x1b[<1u\x1b[?u')
    expect(replies).toEqual(['\x1b[?0u', '\x1b[?0u'])
    term.dispose()
  })

  // Why: the recovery barrier scans it for ownership, so it may only disable modes.
  it('keeps the process boundary ground free of mode enables and lifecycle markers', () => {
    const privateModes = PROCESS_BOUNDARY_GROUND.split('\x1b[?').slice(1)
    const enabled = privateModes.filter((mode) => /^[0-9;]*h/.test(mode))
    expect(enabled.map((mode) => mode.slice(0, mode.indexOf('h')))).toEqual(['25'])
    expect(PROCESS_BOUNDARY_GROUND).not.toContain('\x1b]133;')
    expect(PROCESS_BOUNDARY_GROUND).not.toContain('\x1b[>')
    expect(
      PROCESS_BOUNDARY_GROUND.split('\x1b[=')
        .slice(1)
        .map((set) => set.slice(0, 2))
    ).toEqual(['0u', '0u'])
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
