import { useAppStore } from '../../store'

/** Closes SSH terminal tabs when main retires an unreachable relay generation after an app update. */
export function registerSshRelayGenerationRetiredIpcBridge(unsubs: (() => void)[]): void {
  const unsubscribe = window.api.ssh.onRelayGenerationRetired?.(({ targetId }) => {
    useAppStore.getState().retireDirectSshTerminalsForRelayGeneration(targetId)
  })
  if (unsubscribe) {
    unsubs.push(unsubscribe)
  }
}
