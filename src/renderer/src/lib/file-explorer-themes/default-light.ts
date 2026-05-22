import type { FileExplorerColorTheme } from './types'

/** See `default-dark.ts` for the rationale on `var(--…)` references. */
export const defaultLightTheme: FileExplorerColorTheme = {
  id: 'default-light',
  name: 'Default (Light)',
  mode: 'light',
  background: 'transparent',
  hoverBackground: 'var(--accent)',
  selectedBackground: 'var(--accent)',
  selectedInactiveBackground: 'var(--accent)',
  flashBackground: 'rgb(251 191 36 / 0.2)',
  flashRing: 'rgb(251 191 36 / 0.7)',
  textColor: 'var(--foreground)',
  selectedTextColor: 'var(--accent-foreground)',
  mutedTextColor: 'var(--muted-foreground)',
  gitIgnoredColor: 'var(--git-decoration-ignored)',
  fileIconColor: 'var(--muted-foreground)',
  folderIconColor: 'var(--muted-foreground)',
  gitModifiedColor: 'var(--git-decoration-modified)',
  gitAddedColor: 'var(--git-decoration-added)',
  gitDeletedColor: 'var(--git-decoration-deleted)',
  gitUntrackedColor: 'var(--git-decoration-untracked)',
  gitConflictColor: 'var(--destructive)',
  dropTargetBorderColor: 'var(--border)'
}
