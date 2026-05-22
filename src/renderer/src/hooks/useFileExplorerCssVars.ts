import type { CSSProperties } from 'react'
import type { FileExplorerColorMap } from '@/lib/file-explorer-themes'

const CSS_VAR_BY_KEY: Record<keyof FileExplorerColorMap, string> = {
  background: '--fe-bg',
  hoverBackground: '--fe-bg-hover',
  selectedBackground: '--fe-bg-selected',
  selectedInactiveBackground: '--fe-bg-selected-inactive',
  flashBackground: '--fe-flash-bg',
  flashRing: '--fe-flash-ring',
  textColor: '--fe-text',
  selectedTextColor: '--fe-text-selected',
  mutedTextColor: '--fe-text-muted',
  gitIgnoredColor: '--fe-text-ignored',
  fileIconColor: '--fe-icon-file',
  folderIconColor: '--fe-icon-folder',
  gitModifiedColor: '--fe-git-modified',
  gitAddedColor: '--fe-git-added',
  gitDeletedColor: '--fe-git-deleted',
  gitUntrackedColor: '--fe-git-untracked',
  gitConflictColor: '--fe-git-conflict',
  dropTargetBorderColor: '--fe-drop-border'
}

/**
 * Build the `style` prop that scopes the file-explorer theme as `--fe-*` CSS
 * variables on the shell element. Pass the resulting object as `style={…}`
 * (merging in any additional inline rules); CSS variables apply on the same
 * paint, avoiding the flash of unstyled rows a `useEffect` writer would cause.
 *
 * Per-row inline styles are still avoided — the variables live on the
 * ancestor; rows just reference them via `var(--fe-…)` in className/style.
 */
export function buildFileExplorerCssVars(colors: FileExplorerColorMap): CSSProperties {
  const out: Record<string, string> = {}
  for (const key of Object.keys(CSS_VAR_BY_KEY) as (keyof FileExplorerColorMap)[]) {
    out[CSS_VAR_BY_KEY[key]] = colors[key]
  }
  return out as CSSProperties
}

export { CSS_VAR_BY_KEY as FILE_EXPLORER_CSS_VAR_BY_KEY }
