import type { FileExplorerColorTheme } from './types'

/**
 * Maximum-contrast dark theme: pitch-black background, pure white text,
 * saturated accents for selection and git status. Designed for accessibility
 * and for displays where the default `--accent` (#404040) reads as muddy.
 */
export const highContrastDarkTheme: FileExplorerColorTheme = {
  id: 'high-contrast-dark',
  name: 'High Contrast (Dark)',
  mode: 'dark',
  background: '#000000',
  hoverBackground: '#1f1f1f',
  selectedBackground: '#0e639c',
  selectedInactiveBackground: '#3a3d41',
  flashBackground: 'rgb(255 215 0 / 0.25)',
  flashRing: '#ffd700',
  textColor: '#ffffff',
  selectedTextColor: '#ffffff',
  mutedTextColor: '#c8c8c8',
  gitIgnoredColor: '#7a7a7a',
  fileIconColor: '#c8c8c8',
  folderIconColor: '#ffd700',
  gitModifiedColor: '#e2c08d',
  gitAddedColor: '#81b88b',
  gitDeletedColor: '#f48771',
  gitUntrackedColor: '#73c991',
  gitConflictColor: '#ff5252',
  dropTargetBorderColor: '#ffd700'
}
