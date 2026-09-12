import type { SearchAddon } from '@xterm/addon-search'

type SearchOptions = NonNullable<Parameters<SearchAddon['findNext']>[1]>

// Why: the default xterm SearchAddon highlights blend into common terminal
// backgrounds (see orca#612). Explicit colors give every match a visible yellow
// background and the current match a brighter orange, matching the contrast VS
// Code and iTerm2 use. xterm requires #RRGGBB for the background colors.
const TERMINAL_SEARCH_DECORATIONS = {
  matchBackground: '#5c4a00',
  matchBorder: '#5c4a00',
  matchOverviewRuler: '#ffcc00',
  activeMatchBackground: '#c4580e',
  activeMatchBorder: '#ffcf6b',
  activeMatchColorOverviewRuler: '#ff9900'
} as const

// Pinned rather than left to the addon's identical default so the match counter
// knows where `resultCount` is truncated and can say `1000+` instead of a total
// that reads as exact. Constructor-level: not part of per-find options.
export const TERMINAL_SEARCH_HIGHLIGHT_LIMIT = 1000

/**
 * Why every find must build its options here: the addon keys three behaviors off
 * `decorations` on the options of the *last* call. Without them `_selectResult`
 * creates no active-match decoration, `fireResultsChanged` returns early so
 * `onDidChangeResults` never reports the new position, and `_updateMatches`
 * stops refreshing highlights on write. A navigation call that omits them
 * therefore moves the selection into the scrollback while the visible highlight
 * stays frozen on the previous match — search looks stuck to the current screen.
 */
export function buildTerminalSearchOptions(state: {
  caseSensitive: boolean
  regex: boolean
  incremental?: boolean
}): SearchOptions {
  return {
    caseSensitive: state.caseSensitive,
    regex: state.regex,
    incremental: state.incremental ?? false,
    decorations: { ...TERMINAL_SEARCH_DECORATIONS }
  }
}
