import type { FileExplorerColorTheme } from './types'

/** Inspired by the Atom / One Dark Pro palette popular in VS Code. */
export const oneDarkTheme: FileExplorerColorTheme = {
  id: 'one-dark',
  name: 'One Dark',
  mode: 'dark',
  background: '#21252b',
  hoverBackground: '#2c313a',
  selectedBackground: '#3e4451',
  selectedInactiveBackground: '#2c313a',
  flashBackground: 'rgb(229 192 123 / 0.18)',
  flashRing: '#e5c07b',
  textColor: '#abb2bf',
  selectedTextColor: '#ffffff',
  mutedTextColor: '#828997',
  gitIgnoredColor: '#5c6370',
  fileIconColor: '#828997',
  folderIconColor: '#d19a66',
  gitModifiedColor: '#e5c07b',
  gitAddedColor: '#98c379',
  gitDeletedColor: '#e06c75',
  gitUntrackedColor: '#56b6c2',
  gitConflictColor: '#e06c75',
  dropTargetBorderColor: '#61afef'
}
