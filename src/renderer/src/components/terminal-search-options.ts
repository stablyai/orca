import type { ISearchOptions } from '@xterm/addon-search'

// xterm needs hex colors; explicit highlights stay visible over terminal themes (#612).
const TERMINAL_SEARCH_DECORATIONS = {
  matchBackground: '#5c4a00',
  matchBorder: '#5c4a00',
  matchOverviewRuler: '#ffcc00',
  activeMatchBackground: '#c4580e',
  activeMatchBorder: '#ffcf6b',
  activeMatchColorOverviewRuler: '#ff9900'
}

// Why shared: the addon only moves the active highlight and fires onDidChangeResults when the call carries decorations.
export function buildTerminalSearchOptions(state: {
  caseSensitive: boolean
  regex: boolean
  incremental?: boolean
}): ISearchOptions {
  return {
    caseSensitive: state.caseSensitive,
    regex: state.regex,
    incremental: state.incremental ?? false,
    decorations: TERMINAL_SEARCH_DECORATIONS
  }
}
