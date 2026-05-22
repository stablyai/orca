import type { ComponentType, SVGProps } from 'react'

/**
 * Any component that accepts a `className` and renders an icon. The default
 * theme passes `LucideIcon`; SVG-asset themes pass thin React wrappers around
 * imported SVGs. Both shapes accept `className` so the row can size and
 * (optionally) recolor the icon uniformly.
 */
export type IconNode = ComponentType<{ className?: string } & SVGProps<SVGSVGElement>>

export type FolderIconState = 'closed' | 'open'

export type IconThemeFolderRule = {
  /** Lower-case folder name. Matched case-insensitively against `node.name`. */
  name: string
  closed: IconNode
  /** Optional `open` variant. Falls back to `closed` if omitted. */
  open?: IconNode
}

export type IconThemeFileRule = {
  /** Lower-case full filename. Matched case-insensitively. */
  filename?: string
  /** Regex against the lower-case filename. Pattern matching beats extension. */
  pattern?: RegExp
  /** Extension without leading dot, lower-case (e.g. `'tsx'`, `'tar.gz'`). */
  extension?: string
  icon: IconNode
}

export type IconTheme = {
  id: string
  name: string
  description?: string
  /**
   * `true` ⇒ icons inherit color from text (`currentColor` SVGs, monochrome
   * lucide stroke). The file explorer applies `--fe-icon-file` / `-folder` only
   * when monochrome is `true`; full-color themes render the SVG as-shipped.
   */
  monochrome: boolean
  defaultFileIcon: IconNode
  defaultFolder: { closed: IconNode; open: IconNode }
  /** Evaluated in order: filename match → pattern match → extension match. */
  fileRules: IconThemeFileRule[]
  /** Folder rule lookup is by exact lower-case name. */
  folderRules: IconThemeFolderRule[]
  /**
   * Optional escape hatch evaluated BEFORE `fileRules`. Used by the `default`
   * theme to delegate to the original `getFileTypeIcon` table without
   * duplicating ~150 entries here. Returns the icon (wins) or `null` (fall
   * through to the rule lists).
   */
  resolveFileIcon?: (filePath: string) => IconNode | null
}
