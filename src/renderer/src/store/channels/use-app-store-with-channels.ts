import { useCallback, useSyncExternalStore } from 'react'
import { useAppStore } from '../index'
import type { AppState } from '../types'

/** Like useAppStore, for a selector that reads channel fields: it also wakes on channel-only writes. */
export function useAppStoreWithChannels<T>(selector: (state: AppState) => T): T {
  const read = useCallback(() => selector(useAppStore.getState()), [selector])
  return useSyncExternalStore(useAppStore.subscribe, read, read)
}
