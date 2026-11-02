import { create } from 'zustand'
import { isWebClientLocation } from '@/lib/web-client-location'
import { useAppStore } from '@/store'
import type { GlobalSettings } from '../../../shared/global-settings-types'

/**
 * Whether this window can give plugin frames an isolated guest. Browser clients never can; the
 * desktop app learns it from the first frame entry main hands back (a guest, or the srcdoc
 * fallback when isolated frames are switched off). Null until then: assume it can.
 */
type PluginFrameIsolationState = {
  isolated: boolean | null
  /** The isolated-frames setting the answer was learned under; a change makes it unknown again. */
  learnedUnder?: boolean
}

export const usePluginFrameIsolationStore = create<PluginFrameIsolationState>()(() => ({
  isolated: null
}))

function isolatedFramesSetting(settings: GlobalSettings | null): boolean | undefined {
  return settings?.experimentalPluginIsolatedFrames
}

export function notePluginFrameIsolation(isolated: boolean): void {
  const learnedUnder = isolatedFramesSetting(useAppStore.getState().settings)
  const current = usePluginFrameIsolationStore.getState()
  if (current.isolated !== isolated || current.learnedUnder !== learnedUnder) {
    usePluginFrameIsolationStore.setState({ isolated, learnedUnder })
  }
}

export function usePluginFramesIsolated(): boolean {
  const setting = useAppStore((state) => isolatedFramesSetting(state.settings))
  // Why: main's env override can still force a value, so a changed setting re-asks, not decides.
  const known = usePluginFrameIsolationStore((state) =>
    state.learnedUnder === setting ? state.isolated : null
  )
  return !isWebClientLocation() && known !== false
}
