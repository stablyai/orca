// Why this module is shared: these profiles describe a terminal-protocol
// contract, not a renderer concern. Both the renderer (replaying a snapshot
// into an xterm) and the daemon (seeding a cold-restored session) must clear
// the same mode bits, and duplicating the literals drifted them apart (#12101).

// Why: SerializeAddon replays mode bits assuming reattach to a live TUI, but Orca restores against a fresh shell with none, so stale bits (e.g. focus reporting rings the bell on click) must be reset.
export const RESET_TERMINAL_CURSOR_STYLE = '\x1b[0 q'
export const RESET_KITTY_KEYBOARD_PROTOCOL = '\x1b[<99u\x1b[=0u'
// Why: abandoned byte-gap replay drains live chunks, so a dropped intensity reset must not style them (STA-4042).
export const RESET_GRAPHIC_RENDITION = '\x1b[0m'
// Last so a dead process cannot leave stale attributes in the DECSC register.
const SAVE_GROUNDED_CURSOR = '\x1b7'
// Every mouse mode the daemon can re-arm from a snapshot: protocols 9/1000/1002/1003 + SGR encodings 1006/1016.
export const RESET_MOUSE_REPORTING =
  '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1016l'

// Why: serialized panes can end with a live pen, but the following shell assumes default attributes.
export const POST_REPLAY_MODE_RESET = `${RESET_GRAPHIC_RENDITION}${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}\x1b[?25h${RESET_MOUSE_REPORTING}\x1b[?1004l\x1b[?2004l${SAVE_GROUNDED_CURSOR}`

// Why: same-session live replay; keep cursor/focus cleanup but preserve Kitty flags the running TUI relies on.
export const POST_REPLAY_LIVE_SNAPSHOT_RESET = `${RESET_TERMINAL_CURSOR_STYLE}\x1b[?25h\x1b[?1004l`

// Why: the normal-buffer fallback can follow a dead TUI, so its stale pen and saved pen must not reach the surviving shell.
export const POST_REPLAY_REATTACH_RESET = `${RESET_GRAPHIC_RENDITION}${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}\x1b[?25h${RESET_MOUSE_REPORTING}\x1b[?1004l${SAVE_GROUNDED_CURSOR}`

// Why: a foreground shell proves an alternate-screen owner died without its
// ?1049l cleanup; leave the renderer on the shell's normal buffer as well.
export const POST_REPLAY_DEAD_TUI_RESET = `\x1b[?1049l${POST_REPLAY_REATTACH_RESET}`

// Why: an alt-screen reattach replays the daemon's rehydrateSequences, which re-arm the live TUI's
// mouse modes; wiping them one write later hands drags back to xterm's row selection (#8291).
// Normal-buffer panes keep RESET_MOUSE_REPORTING so a dead TUI's stale modes never reach a shell (#7893).
export const POST_REPLAY_REATTACH_RESET_KEEP_MOUSE = `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}\x1b[?25h\x1b[?1004l`

// Why: a live agent owns focus reporting; resetting ?1004h suppresses the focus-in it needs to re-anchor its cursor (IME).
export const POST_REPLAY_LIVE_AGENT_REATTACH_RESET = `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}\x1b[?25h`

// Why: a live agent owns cursor/focus here; forcing ?25h/?1004l breaks a parked agent that only arms ?1004h at startup.
export const POST_REPLAY_LIVE_AGENT_SNAPSHOT_RESET = RESET_TERMINAL_CURSOR_STYLE

/** Dead-TUI bytes feed a fresh shell; clear their pen and mouse modes before re-serialization. */
export const COLD_RESTORE_SEED_MODE_RESET = `${RESET_GRAPHIC_RENDITION}${RESET_MOUSE_REPORTING}`

// CAN, not a bare ESC: xterm dispatches OSC/DCS/APC with
// `success = code !== 0x18 && code !== 0x1a`, so ESC grounds the parser but
// COMMITS what the gap truncated — a half-read OSC 0 retitles the pane, OSC 52
// writes the clipboard.
export const ABORT_TRUNCATED_CONTROL_STRING = '\x18'

// Live-stream grounding: the drop marker and the abandon paths, which drain
// queued chunks instead of repainting. Parser + pen only — a live TUI keeps
// writing here and owns its charset and margins. Not DECSTR: xterm's soft reset
// wipes the kitty flags agents negotiate only at startup.
export const RESET_AFTER_BYTE_GAP = `${ABORT_TRUNCATED_CONTROL_STRING}${RESET_GRAPHIC_RENDITION}`

// The baseline a serialized snapshot assumes it lands on: SerializeAddon diffs
// cells against DEFAULT attributes and emits no charset at all.
//
// The rule for what belongs here is "state the model re-asserts": `?6l`/`?7h`/
// `?45l`/`4l` are safe because the model re-emits those when SET, so grounding
// plus its re-assertion leaves the renderer matching the model. G1-G3 are
// deliberately NOT grounded — the payload never leaves G0, so they cannot
// affect the restored frame, and the model never speaks about them, so
// resetting is unilateral. `enacs=\E(B\E)0` (screen/tmux/vt100 terminfo)
// designates G1 once at init and then uses bare SO/SI, so grounding G1 would
// render a live app's box drawing as letters.
const REPLAY_BASELINE_TERMINAL_RESET = `${RESET_GRAPHIC_RENDITION}\x0f\x1b(B\x1b[?6l\x1b[?7h\x1b[?45l\x1b[4l`

// Buffer-scoped: margins live on the xterm buffer, and `?1049` neither carries
// them across nor clears them unless it actually swaps.
const REPLAY_BASELINE_BUFFER_RESET = '\x1b[r'

// Last, so the saved-cursor register holds grounded state — otherwise a stranded
// `ESC 7` is reachable through the live TUI's next `ESC 8`. Only a floor: a
// snapshot carrying the model's own DECSC epilogue overwrites it.
/**
 * Prologue that puts a pane on `targetAlternateScreen` and grounds it for a
 * serialized snapshot. Shared because the parity/fuzz harnesses replay the same
 * contract, and re-spelling the literals is what drifted them apart (#12101).
 *
 * The switch is conditional: `?1049` is not a no-op on the target buffer — xterm
 * skips only the swap and still runs restoreCursor() and the kitty flag swap, so
 * emitting it regardless parks a live agent's kitty flags.
 *
 * Grounding brackets a real switch because each side does a different job:
 * before, `?1049h`'s saveCursor() must bank grounded state (and the source
 * buffer's margins get grounded); after, `?1049l`'s restoreCursor() must not
 * reapply the old register over it.
 */
export function buildSnapshotReplayPrologue(args: {
  targetAlternateScreen: boolean
  paneOnAlternateScreen: boolean
}): string {
  // Why explicit: `?1049h` does not clear the alt buffer (xterm's own
  // `1049 should clear altbuffer` FIXME); `\x1b[3J` is safe only for a
  // normal-buffer payload, which carries its own history.
  const clear = args.targetAlternateScreen ? '\x1b[2J\x1b[H' : '\x1b[2J\x1b[3J\x1b[H'
  const ground = `${REPLAY_BASELINE_TERMINAL_RESET}${REPLAY_BASELINE_BUFFER_RESET}`
  if (args.paneOnAlternateScreen === args.targetAlternateScreen) {
    return `${ground}${clear}${SAVE_GROUNDED_CURSOR}`
  }
  const bufferSwitch = args.targetAlternateScreen ? '\x1b[?1049h' : '\x1b[?1049l'
  return `${ground}${bufferSwitch}${ground}${clear}${SAVE_GROUNDED_CURSOR}`
}

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
