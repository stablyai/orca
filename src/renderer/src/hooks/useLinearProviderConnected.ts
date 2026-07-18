import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { useAppStore } from '@/store'

// Why: the Settings sidebar registry and the Settings page must agree on whether
// the Linear section is visible; sharing this selector keeps the nav entry and
// the rendered section from drifting. The context-key guard rejects a status
// fetched for a different runtime environment than the active one.
export function useLinearProviderConnected(): boolean {
  // Why: Cmd+J keeps this hook mounted globally; project to the visibility bit so
  // unrelated Linear metadata and settings updates do not rerender the palette.
  return useAppStore(
    (state) =>
      state.linearStatusContextKey === getProviderRuntimeContextKey(state.settings) &&
      state.linearStatus.connected
  )
}
