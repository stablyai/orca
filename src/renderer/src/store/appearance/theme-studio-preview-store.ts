import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import type { ITheme } from '@xterm/xterm'
import { withTerminalColorOverrides } from '../../../../shared/terminal-themes/terminal-color-overrides'
import type { ThemeStudioMode } from '../../../../shared/theme-studio/theme-studio-draft'
import type { ThemeStudioPreview } from '../../../../shared/theme-studio/theme-studio-protocol'

/** The `orca theme` draft main asked this window to paint, or null when none is open. */
export const useThemeStudioPreviewStore = create<{ preview: ThemeStudioPreview }>(() => ({
  preview: null
}))

/** A terminal palette with the open draft's colors for that mode painted over it. Only the
 *  window's own terminals preview a draft; phones and saved settings keep the user's palette. */
export function withThemeStudioTerminalPreview(
  theme: ITheme | null,
  mode: ThemeStudioMode
): ITheme | null {
  const draftPalette = useThemeStudioPreviewStore.getState().preview?.draft[mode]?.terminal
  return theme && draftPalette ? withTerminalColorOverrides(theme, draftPalette) : theme
}

// Why a floor: re-theming xterm rebuilds glyph colors in every pane; a burst lands as one.
const TERMINAL_REPAINT_INTERVAL_MS = 250

/** Changes only when a draft's terminal palettes do, at most about 4 times a second (the last
 *  change always lands), so terminals repaint for real palette edits alone. */
export function useThemeStudioTerminalPreview(): string | null {
  const key = useThemeStudioPreviewStore((state) => {
    const draft = state.preview?.draft
    return draft ? JSON.stringify([draft.light?.terminal, draft.dark?.terminal]) : null
  })
  const [shown, setShown] = useState(key)
  const lastAt = useRef(0)
  useEffect(() => {
    if (key === shown) {
      return
    }
    const wait = Math.max(0, lastAt.current + TERMINAL_REPAINT_INTERVAL_MS - Date.now())
    const timer = setTimeout(() => {
      lastAt.current = Date.now()
      setShown(key)
    }, wait)
    return () => clearTimeout(timer)
  }, [key, shown])
  return shown
}
