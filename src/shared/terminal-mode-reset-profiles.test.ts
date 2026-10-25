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
  buildKittyKeyboardRestore,
  buildPostReplayLiveAgentReattachReset,
  CONFIRMED_SHELL_MODE_RESET,
  POST_REPLAY_DEAD_TUI_RESET,
  replayPayloadEndsWithCursorHidden
} from './terminal-mode-reset-profiles'
import { TerminalKittyKeyboardModeTracker } from './terminal-kitty-keyboard-mode-tracker'

// Consumers import these bytes; literal expectations catch modes silently disappearing.
describe('terminal mode reset profiles', () => {
  it('clears every mouse protocol and encoding a snapshot can re-arm', () => {
    expect(RESET_MOUSE_REPORTING).toBe(
      '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1016l'
    )
  })

  it('pins the fresh-shell profile', () => {
    expect(POST_REPLAY_MODE_RESET).toBe(
      '\x1b[0m\x1b[0 q\x1b[<99u\x1b[=0u\x1b[>4m\x1b[?25h\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1016l\x1b[?1004l\x1b[?2004l\x1b7'
    )
  })

  it('pins the daemon-reattach profile, which keeps bracketed paste', () => {
    expect(POST_REPLAY_REATTACH_RESET).toBe(
      '\x1b[0m\x1b[0 q\x1b[?25h\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1016l\x1b[?1004l\x1b7'
    )
    expect(POST_REPLAY_REATTACH_RESET).toContain(RESET_GRAPHIC_RENDITION)
    expect(POST_REPLAY_REATTACH_RESET).not.toContain('\x1b[?2004l')
  })

  // A hard-killed alt-screen TUI can return to a shell; retain ?1004l or pane switches ring BEL (#944).
  it('pins the live alternate-screen profile, which keeps mouse reporting but not focus', () => {
    expect(POST_REPLAY_REATTACH_RESET_KEEP_MOUSE).toBe('\x1b[0 q\x1b[?25h\x1b[?1004l')
    expect(POST_REPLAY_REATTACH_RESET_KEEP_MOUSE).not.toContain(RESET_MOUSE_REPORTING)
    expect(POST_REPLAY_REATTACH_RESET_KEEP_MOUSE).not.toBe(POST_REPLAY_LIVE_AGENT_REATTACH_RESET)
  })

  it('pins the process boundary ground', () => {
    expect(PROCESS_BOUNDARY_GROUND).toBe(
      '\x1b[?2026l\x1b[<99u\x1b[=0u\x1b7\x1b[?1049l\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1016l\x1b[?1005l\x1b[?1015l\x1b[?1004l\x1b[?2004l\x1b[?1l\x1b[?66l\x1b[?25h\x1b[0 q\x1b[<99u\x1b[=0u\x1b[>4m\x1b[0m\x1b7'
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
    // The one `CSI >` allowed is the modifyOtherKeys reset; any other would be a kitty push.
    expect(
      PROCESS_BOUNDARY_GROUND.split('\x1b[>')
        .slice(1)
        .map((seq) => seq.slice(0, 2))
    ).toEqual(['4m'])
    expect(
      PROCESS_BOUNDARY_GROUND.split('\x1b[=')
        .slice(1)
        .map((set) => set.slice(0, 2))
    ).toEqual(['0u', '0u'])
  })

  // Absence alone also passes for an empty profile; pin the remaining bytes.
  it('pins the live-snapshot and live-agent profiles', () => {
    expect(POST_REPLAY_LIVE_SNAPSHOT_RESET).toBe('\x1b[0 q\x1b[?25h\x1b[?1004l')
    expect(POST_REPLAY_LIVE_AGENT_REATTACH_RESET).toBe('\x1b[0 q\x1b[?25h')
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

  // Why: a live reattach must keep the app's negotiated flags; the epilogue restores them instead.
  it('keeps Kitty resets out of every live reattach profile', () => {
    for (const profile of [
      POST_REPLAY_REATTACH_RESET,
      POST_REPLAY_REATTACH_RESET_KEEP_MOUSE,
      POST_REPLAY_DEAD_TUI_RESET,
      POST_REPLAY_LIVE_AGENT_REATTACH_RESET,
      POST_REPLAY_LIVE_SNAPSHOT_RESET,
      POST_REPLAY_LIVE_AGENT_SNAPSHOT_RESET,
      buildPostReplayLiveAgentReattachReset('x\x1b[?25l')
    ]) {
      // oxlint-disable-next-line no-control-regex -- terminal escape sequences require control chars
      expect(profile).not.toMatch(/\x1b\[[<=>][0-9;]*u/)
    }
    expect(CONFIRMED_SHELL_MODE_RESET).toBe(
      `${POST_REPLAY_REATTACH_RESET}\x1b[<99u\x1b[=0u\x1b[>4m`
    )
  })

  it('restores proven Kitty flags and only pops unproven ones', () => {
    expect(buildKittyKeyboardRestore(5)).toBe('\x1b[<99u\x1b[=5u')
    expect(buildKittyKeyboardRestore(undefined)).toBe('\x1b[<99u')
  })

  // A replayed push grows xterm’s stack but acts as a mirror set; pop-all prevents the app’s single pop restoring stale flags.
  it("brings xterm and the mirror to 0 on the app's pop after a redelivered push", async () => {
    const term = new Terminal({ allowProposedApi: true, vtExtensions: { kittyKeyboard: true } })
    const mirror = new TerminalKittyKeyboardModeTracker()
    const replies: string[] = []
    term.onData((data) => replies.push(data))
    const write = (data: string): Promise<void> =>
      new Promise((resolve) => term.write(data, resolve))
    const xtermFlags = async (): Promise<string> => {
      replies.length = 0
      await write('\x1b[?u')
      return replies.join('')
    }
    for (const redelivery of ['\x1b[>1u', '\x1b[>1u']) {
      mirror.scanReplay(redelivery)
      await write(redelivery)
    }
    const restore = buildKittyKeyboardRestore(mirror.snapshotFlags)
    mirror.scan(restore)
    await write(restore)
    expect(mirror.flags).toBe(1)
    expect(await xtermFlags()).toBe('\x1b[?1u')

    mirror.scan('\x1b[<u')
    await write('\x1b[<u')
    expect(mirror.flags).toBe(0)
    expect(await xtermFlags()).toBe('\x1b[?0u')
    term.dispose()
  })
})
