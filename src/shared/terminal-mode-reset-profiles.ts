// Why this module is shared: these profiles describe a terminal-protocol
// contract, not a renderer concern. Both the renderer (replaying a snapshot
// into an xterm) and the daemon (seeding a cold-restored session) must clear
// the same mode bits, and duplicating the literals drifted them apart (#12101).

// Why: SerializeAddon replays mode bits assuming reattach to a live TUI, but Orca restores against a fresh shell with none, so stale bits (e.g. focus reporting rings the bell on click) must be reset.
export const RESET_TERMINAL_CURSOR_STYLE = '\x1b[0 q'
export const RESET_KITTY_KEYBOARD_PROTOCOL = '\x1b[<99u\x1b[=0u'
// Every mouse mode the daemon can re-arm from a snapshot: protocols 9/1000/1002/1003 + SGR encodings 1006/1016.
export const RESET_MOUSE_REPORTING =
  '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1016l'

export const POST_REPLAY_MODE_RESET = `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}\x1b[?25h${RESET_MOUSE_REPORTING}\x1b[?1004l\x1b[?2004l`

// Why: same-session live replay; keep cursor/focus cleanup but preserve Kitty flags the running TUI relies on.
export const POST_REPLAY_LIVE_SNAPSHOT_RESET = `${RESET_TERMINAL_CURSOR_STYLE}\x1b[?25h\x1b[?1004l`

// Why: daemon reattach hits a live session, so skip the full reset; still clear cursor/focus/mouse/Kitty bits harmful to a plain shell after a bad TUI exit — safe for live TUIs since the post-reattach SIGWINCH repaints the cursor.
export const POST_REPLAY_REATTACH_RESET = `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}\x1b[?25h${RESET_MOUSE_REPORTING}\x1b[?1004l`

// Why: an alt-screen reattach replays the daemon's rehydrateSequences, which re-arm the live TUI's
// mouse modes; wiping them one write later hands drags back to xterm's row selection (#8291).
// Normal-buffer panes keep RESET_MOUSE_REPORTING so a dead TUI's stale modes never reach a shell (#7893).
export const POST_REPLAY_REATTACH_RESET_KEEP_MOUSE = `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}\x1b[?25h\x1b[?1004l`

// Why: a live agent owns focus reporting; resetting ?1004h suppresses the focus-in it needs to re-anchor its cursor (IME).
export const POST_REPLAY_LIVE_AGENT_REATTACH_RESET = `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}\x1b[?25h`

// Why: a live agent owns cursor/focus here; forcing ?25h/?1004l breaks a parked agent that only arms ?1004h at startup.
export const POST_REPLAY_LIVE_AGENT_SNAPSHOT_RESET = RESET_TERMINAL_CURSOR_STYLE

/** Dead-TUI bytes feed a fresh shell; clear mouse modes here and renderer-owned modes later. */
export const COLD_RESTORE_SEED_MODE_RESET = RESET_MOUSE_REPORTING

// Why separate from every profile above: those clear DEC *mode* bits and none of
// them touches SGR. A recovery path that declares bytes unrecoverable has by
// definition lost whatever turned the pen on, so the pen must be cleared too —
// otherwise a dropped `ESC[22m` leaves bold applied to everything written after
// (STA-4042: hidden-delivery gate drops the reset, the abandoned restore then
// drains queued foreground chunks under the stale pen).
export const RESET_GRAPHIC_RENDITION = '\x1b[0m'

/**
 * State to re-establish when renderer-bound bytes were dropped and the gap
 * cannot be replayed away.
 *
 * Scoped to the pen on purpose. A gap can in principle strand other carried
 * state — an ISO 2022 charset designation, an open OSC 8 hyperlink, a partial
 * escape — and earlier revisions of this reset covered those too. They are
 * dropped here because each one changes what a live TUI sees on a path that
 * runs in production, none of them has a reported symptom behind it, and the
 * pen is what the field reports actually show (STA-4042). Widen this only with
 * a symptom to point at.
 *
 * Deliberately NOT a soft reset (DECSTR) either: xterm's DECSTR wipes kitty
 * flags and stacks (see terminal-kitty-keyboard-mode-tracker applySoftReset),
 * which would silence Option chords for a live agent that negotiates them only
 * at startup.
 */
export const RESET_AFTER_BYTE_GAP = RESET_GRAPHIC_RENDITION

// Why: DECTCEM applies in emission order, so the payload's last ?25l/?25h is the cursor state the TUI left.
export function replayPayloadEndsWithCursorHidden(payload: string): boolean {
  const hideIndex = payload.lastIndexOf('\x1b[?25l')
  return hideIndex !== -1 && hideIndex > payload.lastIndexOf('\x1b[?25h')
}

// Why: some agents hide the real cursor and draw their own, so preserve the payload's final visibility (pty-connection re-shows it if the agent was actually a dead TUI).
export function buildPostReplayLiveAgentReattachReset(payload: string): string {
  return replayPayloadEndsWithCursorHidden(payload)
    ? `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}`
    : POST_REPLAY_LIVE_AGENT_REATTACH_RESET
}
