import { activeWindowMaterial } from './window-material-runtime'
import { useThemeBackgroundStore } from '@/store/theme-background'

/** Something paints under translucent terminals: the window material or a theme background image. */
export function windowBackdropActive(): boolean {
  return activeWindowMaterial() !== 'off' || useThemeBackgroundStore.getState().active
}

export function useWindowBackdropActive(): boolean {
  const themeBackground = useThemeBackgroundStore((state) => state.active)
  return themeBackground || activeWindowMaterial() !== 'off'
}
