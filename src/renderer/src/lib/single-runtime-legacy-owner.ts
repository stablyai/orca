import { getPairedWebClientEnvironmentId } from './paired-web-client-host'

export type SingleRuntimeLegacyOwnerState = {
  settings?: { activeRuntimeEnvironmentId?: string | null } | null
  runtimeEnvironments?: readonly { id: string }[]
}

export function getSingleFocusedRuntimeEnvironmentId(
  state: SingleRuntimeLegacyOwnerState
): string | null {
  const webHost = getPairedWebClientEnvironmentId(state)
  if (webHost) {
    return webHost
  }
  const focused = state.settings?.activeRuntimeEnvironmentId?.trim()
  if (!focused) {
    return null
  }
  const savedIds = state.runtimeEnvironments?.map((environment) => environment.id.trim())
  return savedIds === undefined || (savedIds.length === 1 && savedIds[0] === focused)
    ? focused
    : null
}
