import type { FileExplorerColorTheme } from './types'

/**
 * Reproduces the file explorer's current dark-mode look 1:1. Uses `var(--…)`
 * references so global Tailwind tokens (`--accent`, `--foreground`, etc.) stay
 * the single source of truth — if Orca ever retunes its dark palette, this
 * theme inherits the change.
 *
 * Why hex for git decorations: those values are pulled directly from
 * `main.css` (`--git-decoration-*`) and live next to git status code; keeping
 * them in this theme would duplicate global state. We re-reference the same
 * CSS variables instead.
 */
export const defaultDarkTheme: FileExplorerColorTheme = {
  id: 'default-dark',
  name: 'Default (Dark)',
  mode: 'dark',
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
