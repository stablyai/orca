import { useEffect } from 'react'
import { useAppStore } from '../store'
import { getStructuredAgentSessionTurnCompletionFeed } from './structured-agent-session-turn-completion-feed'

export function ForwardedStructuredReadFeeds(): null {
  useEffect(() => {
    const held = new Map<string, () => void>()
    let environments: string[] = []
    let stopped = false
    const reconcile = (): void => {
      const known = new Set(
        useAppStore.getState().runtimeEnvironments.map((environment) => environment.id)
      )
      const wanted = new Set(environments.filter((id) => known.has(id)))
      for (const [id, release] of held) {
        if (!wanted.has(id)) {
          release()
          held.delete(id)
        }
      }
      for (const id of wanted) {
        if (!held.has(id)) {
          held.set(
            id,
            getStructuredAgentSessionTurnCompletionFeed({
              kind: 'environment',
              environmentId: id
            }).activate()
          )
        }
      }
    }
    const accept = (next: string[]): void => {
      if (!stopped) {
        environments = next
        reconcile()
      }
    }
    let changed = false
    const unlisten = window.api.notifications.onForwardedEnvironments((next) => {
      changed = true
      accept(next)
    })
    void window.api.notifications.getForwardedEnvironments().then((next) => {
      if (!changed) {
        accept(next)
      }
    })
    const unstore = useAppStore.subscribe((state, previous) => {
      if (state.runtimeEnvironments !== previous.runtimeEnvironments) {
        reconcile()
      }
    })
    return () => {
      stopped = true
      unlisten()
      unstore()
      for (const release of held.values()) {
        release()
      }
    }
  }, [])
  return null
}
