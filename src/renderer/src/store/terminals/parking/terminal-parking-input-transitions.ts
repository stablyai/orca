import type { StoreApi } from 'zustand'
import type { AppState } from '../../types'
import {
  acceptTerminalParkingInputs,
  publishAcceptedTerminalParkingInputs
} from './terminal-parking-input-owner'
import { runtimeStatusSubscriptionsFor } from '../../slices/runtime-status/views/runtime-status-subscriptions'

type ParkingInputStore = Pick<StoreApi<AppState>, 'getState' | 'subscribe'>

/** Read the current accepted state so reentrant notifications cannot restore an older owner. */
export function installTerminalParkingInputs(store: ParkingInputStore): () => void {
  const hostStatuses = runtimeStatusSubscriptionsFor(store)
  acceptTerminalParkingInputs(store.getState(), hostStatuses.readStatuses())
  const accept = (): void => {
    publishAcceptedTerminalParkingInputs(
      acceptTerminalParkingInputs(store.getState(), hostStatuses.readStatuses())
    )
  }
  return hostStatuses.subscribeStore(accept)
}
