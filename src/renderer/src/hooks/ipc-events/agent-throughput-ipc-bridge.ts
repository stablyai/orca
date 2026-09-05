import { useAppStore } from '../../store'

export function registerAgentThroughputIpcBridge(unsubs: (() => void)[]): void {
  const api = window.api.agentThroughput
  unsubs.push(
    api.onSet((sample) => {
      useAppStore.getState().setAgentThroughput(sample)
    })
  )
  unsubs.push(
    api.onClear(({ paneKey }) => {
      useAppStore.getState().clearAgentThroughput(paneKey)
    })
  )
  // Why: pushes that raced the startup pull win by observedAt inside the merge, so order here doesn't matter.
  void api
    .getSnapshot()
    .then((samples) => {
      useAppStore.getState().mergeAgentThroughputSnapshot(samples)
    })
    .catch((error: unknown) => {
      console.warn('[agent-throughput] snapshot failed', error)
    })
}
