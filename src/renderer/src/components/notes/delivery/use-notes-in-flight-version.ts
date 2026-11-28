import { useAppViewExternalStore } from '@/store/retained-views/app-state-view'
import { getNotesInFlightVersion, subscribeToNotesInFlight } from './notes-send-in-flight'

export function useNotesInFlightVersion(): number {
  return useAppViewExternalStore(
    subscribeToNotesInFlight,
    getNotesInFlightVersion,
    getNotesInFlightVersion
  )
}
