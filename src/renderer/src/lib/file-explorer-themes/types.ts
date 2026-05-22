/**
 * Color tokens that drive the file explorer surface. Each token resolves to a
 * CSS color string (hex, rgb(), hsl(), or a `var(--…)` reference).
 *
 * Why mirror VS Code: a separate file-explorer surface lets users restyle the
 * file tree without affecting global tokens (`--accent`, `--foreground`) that
 * other panes rely on.
 */
export type FileExplorerColorKey =
  | 'background'
  | 'hoverBackground'
  | 'selectedBackground'
  | 'selectedInactiveBackground'
  | 'flashBackground'
  | 'flashRing'
  | 'textColor'
  | 'selectedTextColor'
  | 'mutedTextColor'
  | 'gitIgnoredColor'
  | 'fileIconColor'
  | 'folderIconColor'
  | 'gitModifiedColor'
  | 'gitAddedColor'
  | 'gitDeletedColor'
  | 'gitUntrackedColor'
  | 'gitConflictColor'
  | 'dropTargetBorderColor'

export type FileExplorerColorMap = Record<FileExplorerColorKey, string>

export type FileExplorerColorTheme = FileExplorerColorMap & {
  id: string
  name: string
  mode: 'dark' | 'light'
}

/**
 * Per-user override layer applied on top of a built-in theme. Stored in
 * `GlobalSettings` as the matching `fileExplorerColorOverrides{Dark,Light}`
 * key. Only keys present in the record override the underlying theme; missing
 * keys fall through to the theme value.
 */
export type FileExplorerColorOverrides = Partial<FileExplorerColorMap>
