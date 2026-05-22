import { useMemo } from 'react'
import {
  DEFAULT_ICON_THEME_ID,
  getIconTheme,
  type IconNode,
  type IconTheme,
  resolveIcon
} from '@/lib/icon-themes'
import { useAppStore } from '@/store'

export type ResolvedFileIcon = {
  Icon: IconNode
  /** Mirrors `theme.monochrome` — callers tint when `true`, leave alone when `false`. */
  monochrome: boolean
}

/**
 * Resolve the icon to render for a given path under the active icon theme.
 * `isDirectory` and `isOpen` select between the folder and file branches; for
 * folders, `isOpen` chooses between the open/closed variants.
 *
 * Returns both the component AND the theme's `monochrome` flag so the row can
 * decide whether to apply `--fe-icon-*` tinting (monochrome) or let the theme
 * paint its own colors (color/SVG themes).
 */
export function useFileIcon(
  filePath: string,
  isDirectory: boolean,
  isOpen: boolean
): ResolvedFileIcon {
  const themeId = useAppStore((s) => s.settings?.fileExplorerIconTheme) ?? DEFAULT_ICON_THEME_ID

  return useMemo<ResolvedFileIcon>(() => {
    const theme: IconTheme = getIconTheme(themeId) ?? getIconTheme(DEFAULT_ICON_THEME_ID)!
    return {
      Icon: resolveIcon(theme, filePath, isDirectory, isOpen),
      monochrome: theme.monochrome
    }
  }, [themeId, filePath, isDirectory, isOpen])
}
