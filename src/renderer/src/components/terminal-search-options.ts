import type { ISearchOptions } from '@xterm/addon-search'

export function createTerminalSearchOptions(
  flags: { caseSensitive: boolean; regex: boolean },
  incremental = false
): ISearchOptions {
  return {
    caseSensitive: flags.caseSensitive,
    regex: flags.regex,
    incremental,
    // xterm needs hex colors and decorated options on every call to retain refresh ownership.
    decorations: {
      matchBackground: '#5c4a00',
      matchBorder: '#5c4a00',
      matchOverviewRuler: '#ffcc00',
      activeMatchBackground: '#c4580e',
      activeMatchBorder: '#ffcf6b',
      activeMatchColorOverviewRuler: '#ff9900'
    }
  }
}
