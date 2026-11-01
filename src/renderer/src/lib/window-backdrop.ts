import { useThemeBackgroundStore } from '@/store/theme-background'

/** Something paints under translucent terminals: today a theme background image. */
export function windowBackdropActive(): boolean {
  return useThemeBackgroundStore.getState().active
}

export function useWindowBackdropActive(): boolean {
  return useThemeBackgroundStore((state) => state.active)
}
