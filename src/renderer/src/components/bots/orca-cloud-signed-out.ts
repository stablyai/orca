// Whether a bot's Orca Cloud features wait on this window's Orca sign-in.
import { useAppStore } from '@/store'
import type { OrcaProfileAuthStatus } from '../../../../shared/orca-profiles/orca-profiles'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'

function signedOut(status: OrcaProfileAuthStatus | null): boolean {
  return status?.state === 'local' || status?.state === 'reconnect-required'
}

/** `useOrcaCloudSignedOut` for code outside React. */
export function readOrcaCloudSignedOut(hostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID): boolean {
  return (
    hostId === LOCAL_EXECUTION_HOST_ID && signedOut(useAppStore.getState().orcaProfileAuthStatus)
  )
}

/**
 * Whether Orca Cloud features of `hostId`'s bots wait on this window's sign-in. Only this computer's:
 * Sign in here signs in this desktop, never a paired server.
 */
export function useOrcaCloudSignedOut(hostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID): boolean {
  return useAppStore(
    (state) => hostId === LOCAL_EXECUTION_HOST_ID && signedOut(state.orcaProfileAuthStatus)
  )
}
