import { create } from 'zustand'
import type { TerminalColorOverrides } from '../../../../shared/terminal-themes/terminal-color-overrides'
import type { ThemeStudioMode } from '../../../../shared/theme-studio/theme-studio-draft'
import type { ThemeStudioPreview } from '../../../../shared/theme-studio/theme-studio-protocol'

/** The `orca theme` draft main asked this window to paint, or null when none is open. */
export const useThemeStudioPreviewStore = create<{ preview: ThemeStudioPreview }>(() => ({
  preview: null
}))

/** A draft's palette for a terminal slot; read where the terminal palette is resolved. */
export function themeStudioTerminalPreview(mode: ThemeStudioMode): TerminalColorOverrides | null {
  return useThemeStudioPreviewStore.getState().preview?.draft[mode]?.terminal ?? null
}

/** Changes with each painted draft, so mounted terminals repaint; their writes are value-gated. */
export function useThemeStudioTerminalPreview(): number | null {
  return useThemeStudioPreviewStore((state) => state.preview?.revision ?? null)
}
