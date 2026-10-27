import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { useAppStore } from '@/store'

// Share visibility policy between Settings nav/page and reject another runtime’s cached status.
export function useLinearProviderConnected(): boolean {
  // Cmd+J retains this hook globally; select only visibility so unrelated metadata cannot rerender the palette.
  return useAppStore(
    (state) =>
      state.linearStatusContextKey === getProviderRuntimeContextKey(state.settings) &&
      state.linearStatus.connected
  )
}
