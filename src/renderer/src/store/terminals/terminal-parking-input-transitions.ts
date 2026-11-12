import type { StoreApi } from 'zustand'
import type { AppState } from '../types'
import {
  acceptTerminalParkingInputs,
  publishAcceptedTerminalParkingInputs
} from './terminal-parking-input-owner'

type ParkingInputStore = Pick<StoreApi<AppState>, 'getState' | 'subscribe'>

/** Read the current accepted state so reentrant notifications cannot restore an older owner. */
export function installTerminalParkingInputs(store: ParkingInputStore): () => void {
  acceptTerminalParkingInputs(store.getState())
  return store.subscribe(() => {
    publishAcceptedTerminalParkingInputs(acceptTerminalParkingInputs(store.getState()))
  })
}
