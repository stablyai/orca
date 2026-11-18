import { readAppStoreListenerCounts } from '../channels/app-store-notification-router'

/** Every live app store listener, React selectors included. */
export function readStoreListenerCount(): number | null {
  return readAppStoreListenerCounts()?.all ?? null
}
