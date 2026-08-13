import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { useAppStore } from '@/store'

// Why: the Settings sidebar registry and the Settings page must agree on whether
// the Huly section is visible; sharing this selector keeps the nav entry and
// the rendered section from drifting. The context-key guard rejects a status
// fetched for a different runtime environment than the active one.
export function useHulyProviderConnected(): boolean {
  // Why: Huly-first ordering in the source picker depends on this boolean
  // resolving synchronously after the status fetch — see orderTaskProviders.
  return useAppStore(
    (state) =>
      state.hulyStatusContextKey === getProviderRuntimeContextKey(state.settings) &&
      state.hulyStatus.connected
  )
}
