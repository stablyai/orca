import { useAppStore } from '../../store'

export function registerDetachedTerminalIpcBridge(unsubs: (() => void)[]): void {
  const subscribe = window.api.detachedTerminal?.onClosed
  if (typeof subscribe !== 'function') {
    return
  }
  unsubs.push(
    subscribe((tabId) => {
      useAppStore.getState().redockDetachedTerminalTab(tabId)
    })
  )
}
