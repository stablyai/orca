import { create } from 'zustand'
import { isWebClientLocation } from '@/lib/web-client-location'

/**
 * Whether this window can give plugin frames an isolated guest. Browser clients never can; the
 * desktop app learns it from the first frame entry main hands back (a guest, or the srcdoc
 * fallback when isolated frames are switched off). Null until then: assume it can.
 */
type PluginFrameIsolationState = { isolated: boolean | null }

export const usePluginFrameIsolationStore = create<PluginFrameIsolationState>()(() => ({
  isolated: null
}))

export function notePluginFrameIsolation(isolated: boolean): void {
  if (usePluginFrameIsolationStore.getState().isolated !== isolated) {
    usePluginFrameIsolationStore.setState({ isolated })
  }
}

export function usePluginFramesIsolated(): boolean {
  const isolated = usePluginFrameIsolationStore((state) => state.isolated)
  return !isWebClientLocation() && isolated !== false
}
