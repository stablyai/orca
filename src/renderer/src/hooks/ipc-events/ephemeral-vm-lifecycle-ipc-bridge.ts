import { useAppStore } from '../../store'

/** Mirror VM lifecycle status (suspend, resume, cleanup) so host health reads it live. */
export function registerEphemeralVmLifecycleIpcBridge(unsubs: (() => void)[]): void {
  const api = window.api?.ephemeralVm
  if (!api?.listRuntimes) {
    return
  }
  const refresh = (): void => {
    void useAppStore
      .getState()
      .refreshEphemeralVmRuntimes()
      .catch((error) => console.error('Failed to read ephemeral VM runtimes:', error))
  }
  if (api.onRuntimesChanged) {
    unsubs.push(api.onRuntimesChanged(refresh))
  }
  refresh()
}
