import { useThemeBackgroundStore } from '@/store/theme-background'
import { activeWindowMaterial } from './window-material-runtime'

/** Something paints under translucent terminals: the window material (fixed per window) or a theme background image. */
export function windowBackdropActive(): boolean {
  return activeWindowMaterial() !== 'off' || useThemeBackgroundStore.getState().active
}

export function useWindowBackdropActive(): boolean {
  const themeBackgroundActive = useThemeBackgroundStore((state) => state.active)
  return activeWindowMaterial() !== 'off' || themeBackgroundActive
}
