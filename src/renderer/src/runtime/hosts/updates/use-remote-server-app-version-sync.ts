import { useEffect } from 'react'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { useAppStore } from '@/store/index'
import { runRemoteServerAppVersionSync } from './remote-server-app-version-sync'

let started = false

export function useRemoteServerAppVersionSync(): void {
  const terminalStartupRestorationReady = useAppStore(
    (state) => state.terminalStartupRestorationReady
  )
  useEffect(() => {
    if (started || !terminalStartupRestorationReady || isWebClientLocation()) {
      return
    }
    started = true
    void runRemoteServerAppVersionSync({
      getCurrentVersion: () => window.api.updater.getVersion(),
      storage: {
        getItem: (key) => window.localStorage.getItem(key),
        setItem: (key, value) => window.localStorage.setItem(key, value)
      },
      store: useAppStore
    }).catch((error) => {
      console.warn('Failed to sync paired servers after the app update:', error)
    })
  }, [terminalStartupRestorationReady])
}
