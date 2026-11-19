/**
 * The view a terminal/agent tab renders. `terminal` is the raw xterm surface, `chat`
 * overlays the structured agent-session transcript, and `map` overlays the live agent
 * map (a zoetrope-style node graph with a time scrubber). Unknown values from an older
 * or newer build normalize to `terminal` at the read boundary, so a mixed-version session
 * never crashes on a mode it doesn't know.
 */
export type TerminalViewMode = 'terminal' | 'chat' | 'map'

export const TERMINAL_VIEW_MODES: readonly TerminalViewMode[] = ['terminal', 'chat', 'map']

/** `true` when the value is one of the known modes; used to normalize unknown persisted values. */
export function isTerminalViewMode(value: unknown): value is TerminalViewMode {
  return typeof value === 'string' && TERMINAL_VIEW_MODES.some((mode) => mode === value)
}
