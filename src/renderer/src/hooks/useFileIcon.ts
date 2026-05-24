import React, { useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_ICON_THEME_ID,
  getIconTheme,
  type IconNode,
  type IconTheme,
  resolveIcon,
  subscribeUserIconThemes
} from '@/lib/icon-themes'
import { useAppStore } from '@/store'

// Why: user-imported themes are hydrated asynchronously on startup.
// This counter bumps when the user catalog changes, so hooks that resolve
// icons re-render once the real theme data is available.
function useUserThemeVersion(): number {
  const [v, setV] = useState(0)
  useEffect(() => subscribeUserIconThemes(() => setV((n) => n + 1)), [])
  return v
}

export type ResolvedFileIcon = {
  Icon: IconNode
  /** Mirrors `theme.monochrome` — callers tint when `true`, leave alone when `false`. */
  monochrome: boolean
}

export function useFileIcon(
  filePath: string,
  isDirectory: boolean,
  isOpen: boolean
): ResolvedFileIcon {
  const themeId = useAppStore((s) => s.settings?.fileExplorerIconTheme) ?? DEFAULT_ICON_THEME_ID
  const v = useUserThemeVersion()

  return useMemo<ResolvedFileIcon>(() => {
    const theme: IconTheme = getIconTheme(themeId) ?? getIconTheme(DEFAULT_ICON_THEME_ID)!
    return {
      Icon: resolveIcon(theme, filePath, isDirectory, isOpen),
      monochrome: theme.monochrome
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- v triggers re-eval on hydration
  }, [themeId, filePath, isDirectory, isOpen, v])
}

export function useThemedFileIcon(filePath: string): IconNode {
  const themeId = useAppStore((s) => s.settings?.fileExplorerIconTheme) ?? DEFAULT_ICON_THEME_ID
  const v = useUserThemeVersion()
  return useMemo(() => {
    const theme: IconTheme = getIconTheme(themeId) ?? getIconTheme(DEFAULT_ICON_THEME_ID)!
    return resolveIcon(theme, filePath, false, false)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- v triggers re-eval on hydration
  }, [themeId, filePath, v])
}

type ThemedIconProps = {
  filePath: string
  isDirectory?: boolean
  isOpen?: boolean
  className?: string
  style?: React.CSSProperties
}

/**
 * Component wrapper around the icon theme resolver. Safe to use inside
 * `.map()` and other callbacks where hooks aren't allowed — each instance
 * is its own component with its own hook call.
 */
export function ThemedFileIcon({
  filePath,
  isDirectory = false,
  isOpen = false,
  className,
  style
}: ThemedIconProps): React.JSX.Element {
  const themeId = useAppStore((s) => s.settings?.fileExplorerIconTheme) ?? DEFAULT_ICON_THEME_ID
  const v = useUserThemeVersion()
  const Icon = useMemo(() => {
    const theme: IconTheme = getIconTheme(themeId) ?? getIconTheme(DEFAULT_ICON_THEME_ID)!
    return resolveIcon(theme, filePath, isDirectory, isOpen)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- v triggers re-eval on hydration
  }, [themeId, filePath, isDirectory, isOpen, v])
  return React.createElement(Icon, { className, style })
}
