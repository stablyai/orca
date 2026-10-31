// Share renderer replay and daemon cold-restore mode contracts; duplicated literals drifted (#12101).

// Cold restores target a fresh shell; stale serialized TUI modes would leak input/focus reports into it.
export const RESET_TERMINAL_CURSOR_STYLE = '\x1b[0 q'
export const RESET_KITTY_KEYBOARD_PROTOCOL = '\x1b[<99u\x1b[=0u'
// Why beside kitty: a dead pi leaves modifyOtherKeys armed, and the shell would get `CSI 27;2;13~` for Shift+Enter.
export const RESET_MODIFY_OTHER_KEYS = '\x1b[>4m'

/** Pop replay-duplicated pushes before reasserting proven flags; unknown flags only pop to a still-unproven zero. */
export function buildKittyKeyboardRestore(provenFlags: number | undefined): string {
  return provenFlags === undefined ? '\x1b[<99u' : `\x1b[<99u\x1b[=${provenFlags}u`
}

// Why: abandoned byte-gap replay drains live chunks, so a dropped intensity reset must not style them (STA-4042).
export const RESET_GRAPHIC_RENDITION = '\x1b[0m'
// Last so a dead process cannot leave stale attributes in the DECSC register.
const SAVE_GROUNDED_CURSOR = '\x1b7'
// Every mouse mode the daemon can re-arm from a snapshot: protocols 9/1000/1002/1003 + SGR encodings 1006/1016.
export const RESET_MOUSE_REPORTING =
  '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1016l'

// Why: serialized panes can end with a live pen, but the following shell assumes default attributes.
export const POST_REPLAY_MODE_RESET = `${RESET_GRAPHIC_RENDITION}${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}${RESET_MODIFY_OTHER_KEYS}\x1b[?25h${RESET_MOUSE_REPORTING}\x1b[?1004l\x1b[?2004l${SAVE_GROUNDED_CURSOR}`

// Why: same-session live replay; keep cursor/focus cleanup (the replay epilogue re-asserts Kitty flags).
export const POST_REPLAY_LIVE_SNAPSHOT_RESET = `${RESET_TERMINAL_CURSOR_STYLE}\x1b[?25h\x1b[?1004l`

// Why: the normal-buffer fallback can follow a dead TUI, so its stale pen and saved pen must not reach the surviving shell.
// No Kitty reset in any reattach profile: the replay epilogue restores the host's flags instead.
export const POST_REPLAY_REATTACH_RESET = `${RESET_GRAPHIC_RENDITION}${RESET_TERMINAL_CURSOR_STYLE}\x1b[?25h${RESET_MOUSE_REPORTING}\x1b[?1004l${SAVE_GROUNDED_CURSOR}`

// Why: a foreground proof says the app is gone, so its Kitty flags go with its other modes.
export const CONFIRMED_SHELL_MODE_RESET = `${POST_REPLAY_REATTACH_RESET}${RESET_KITTY_KEYBOARD_PROTOCOL}${RESET_MODIFY_OTHER_KEYS}`

// A proven shell means the TUI died without ?1049l; return to the normal buffer too.
export const POST_REPLAY_DEAD_TUI_RESET = `\x1b[?1049l${POST_REPLAY_REATTACH_RESET}`

// Live alt-screen TUIs retain rehydrated mouse modes or drags become selection (#8291); normal-buffer shells must shed stale modes (#7893).
export const POST_REPLAY_REATTACH_RESET_KEEP_MOUSE = `${RESET_TERMINAL_CURSOR_STYLE}\x1b[?25h\x1b[?1004l`

// Why: a live agent owns focus reporting; resetting ?1004h suppresses the focus-in it needs to re-anchor its cursor (IME).
export const POST_REPLAY_LIVE_AGENT_REATTACH_RESET = `${RESET_TERMINAL_CURSOR_STYLE}\x1b[?25h`

// Why: a live agent owns cursor/focus here; forcing ?25h/?1004l breaks a parked agent that only arms ?1004h at startup.
export const POST_REPLAY_LIVE_AGENT_SNAPSHOT_RESET = RESET_TERMINAL_CURSOR_STYLE

// CAN aborts without side effects; bare ESC commits truncated OSC/DCS/APC (including title and OSC 52 clipboard writes).
export const ABORT_TRUNCATED_CONTROL_STRING = '\x18'

// A lost ?2026l freezes repainting until xterm’s 1s flush; snapshots never reassert this mode.
// Releasing early may flash a partial frame over the last coherent one, but prevents increasingly stale frozen output after a byte gap.
export const RELEASE_SYNCHRONIZED_OUTPUT = '\x1b[?2026l'

// ?1049l restores the cursor even on normal; save there first. On alt, the save leaves the shell’s normal register intact.
const LEAVE_ALTERNATE_SCREEN_KEEPING_NORMAL_CURSOR = `${SAVE_GROUNDED_CURSOR}\x1b[?1049l`
// UTF-8 and urxvt encodings RESET_MOUSE_REPORTING leaves out; xterm ignores them, other hosts may not.
const RESET_LEGACY_MOUSE_ENCODINGS = '\x1b[?1005l\x1b[?1015l'
const RESET_FOCUS_REPORTING = '\x1b[?1004l'
const RESET_BRACKETED_PASTE = '\x1b[?2004l'
const RESET_APPLICATION_CURSOR_AND_KEYPAD = '\x1b[?1l\x1b[?66l'
const SHOW_CURSOR = '\x1b[?25h'

/** Ground cold restores and proven process ends without ownership signals (OSC 133 or mode enables). Reset per-screen Kitty stacks around ?1049l.
 * keepFocusReporting preserves ConPTY’s pane-lifetime focus mode. */
export function buildProcessBoundaryGround(opts: { keepFocusReporting: boolean }): string {
  const focus = opts.keepFocusReporting ? '' : RESET_FOCUS_REPORTING
  // Release the dead process’s 2026 latch first; nothing remains to close it.
  return `${RELEASE_SYNCHRONIZED_OUTPUT}${RESET_KITTY_KEYBOARD_PROTOCOL}${LEAVE_ALTERNATE_SCREEN_KEEPING_NORMAL_CURSOR}${RESET_MOUSE_REPORTING}${RESET_LEGACY_MOUSE_ENCODINGS}${focus}${RESET_BRACKETED_PASTE}${RESET_APPLICATION_CURSOR_AND_KEYPAD}${SHOW_CURSOR}${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}${RESET_MODIFY_OTHER_KEYS}${RESET_GRAPHIC_RENDITION}${SAVE_GROUNDED_CURSOR}`
}

export const PROCESS_BOUNDARY_GROUND = buildProcessBoundaryGround({ keepFocusReporting: false })

// Byte-gap/abandon paths drain live output: ground parser and pen only. The TUI owns charset/margins; DECSTR would erase startup-only Kitty flags.
export const RESET_AFTER_BYTE_GAP = `${ABORT_TRUNCATED_CONTROL_STRING}${RELEASE_SYNCHRONIZED_OUTPUT}${RESET_GRAPHIC_RENDITION}`

// Start from default pen/G0; ground modes only when the serializer can reassert them.
// Keep G1–G3: snapshots never reassert them, and screen/tmux designate G1 once then use SO/SI for box drawing.
const REPLAY_BASELINE_TERMINAL_RESET = `${RELEASE_SYNCHRONIZED_OUTPUT}${RESET_GRAPHIC_RENDITION}\x0f\x1b(B\x1b[?6l\x1b[?7h\x1b[?45l\x1b[4l`

// Margins belong to the buffer; ?1049 carries none and clears them only on a real swap.
const REPLAY_BASELINE_BUFFER_RESET = '\x1b[r'

/** Share the production snapshot baseline with parity/fuzz harnesses (#12101). Switch only when needed: even a no-swap ?1049 restores cursors/swaps Kitty slots.
 * Ground before switching so saveCursor banks defaults, and after so restoreCursor cannot reapply stale state.
 * Save the grounded cursor last as a floor; the snapshot’s own DECSC epilogue may overwrite it. */
export function buildSnapshotReplayPrologue(args: {
  targetAlternateScreen: boolean
  paneOnAlternateScreen: boolean
}): string {
  // ?1049h does not clear alt; explicitly clear it. Only normal payloads carry history, making 3J safe there.
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

// Live agents may draw their own cursor; preserve final visibility unless later process evidence proves the TUI dead.
export function buildPostReplayLiveAgentReattachReset(payload: string): string {
  return replayPayloadEndsWithCursorHidden(payload)
    ? RESET_TERMINAL_CURSOR_STYLE
    : POST_REPLAY_LIVE_AGENT_REATTACH_RESET
}
