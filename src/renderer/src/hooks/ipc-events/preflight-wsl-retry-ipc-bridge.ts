import { useAppStore } from '../../store'

/** Main saw a WSL distro running that a background check was refused for: re-ask what it refused. */
export function registerPreflightWslRetryIpcBridge(unsubs: (() => void)[]): void {
  const onWslDistroRunning = window.api.preflight?.onWslDistroRunning
  if (typeof onWslDistroRunning !== 'function') {
    return
  }
  unsubs.push(
    onWslDistroRunning(() => {
      const state = useAppStore.getState()
      if (state.preflightStatusError !== null) {
        void state.refreshPreflightStatus()
      }
      // A refused inventory is marked failed, so this re-detects it; a known list is reused.
      void state.ensureDetectedAgents()
    })
  )
}
