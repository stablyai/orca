import type { FileExplorerColorTheme } from './types'

/** Inspired by Ethan Schoonover's Solarized Light palette. */
export const solarizedLightTheme: FileExplorerColorTheme = {
  id: 'solarized-light',
  name: 'Solarized Light',
  mode: 'light',
  background: '#fdf6e3',
  hoverBackground: '#eee8d5',
  selectedBackground: '#d3cbb7',
  selectedInactiveBackground: '#eee8d5',
  flashBackground: 'rgb(181 137 0 / 0.18)',
  flashRing: '#b58900',
  textColor: '#586e75',
  selectedTextColor: '#073642',
  mutedTextColor: '#93a1a1',
  gitIgnoredColor: '#93a1a1',
  fileIconColor: '#93a1a1',
  folderIconColor: '#b58900',
  gitModifiedColor: '#b58900',
  gitAddedColor: '#859900',
  gitDeletedColor: '#dc322f',
  gitUntrackedColor: '#2aa198',
  gitConflictColor: '#dc322f',
  dropTargetBorderColor: '#268bd2'
}
