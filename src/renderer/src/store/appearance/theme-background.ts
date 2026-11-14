import { create } from 'zustand'

/** True while the active app theme paints a background image under translucent terminals. */
export const useThemeBackgroundStore = create<{ active: boolean }>()(() => ({ active: false }))
