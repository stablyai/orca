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

/** Changes only when a draft's terminal palettes do, so terminals repaint for those edits alone. */
export function useThemeStudioTerminalPreview(): string | null {
  return useThemeStudioPreviewStore((state) => {
    const draft = state.preview?.draft
    return draft ? JSON.stringify([draft.light?.terminal, draft.dark?.terminal]) : null
  })
}
