// The deep link into the "Agent accounts & secrets" panel. The panel shell registers itself
// here; prompts that point into it (e.g. a Details link) show the link only once it's there.
import { useSyncExternalStore } from 'react'

export type AgentHostPanelFocus = 'claude' | 'codex' | 'keys' | { secret: string }

export type OpenAgentHostPanel = (target: {
  /** The runtime environment id of the host. */
  hostId: string
  focus?: AgentHostPanelFocus
}) => void

let opener: OpenAgentHostPanel | null = null
const listeners = new Set<() => void>()

/** Called by the panel shell when it mounts; returns the unregister function. */
export function registerAgentHostPanelOpener(open: OpenAgentHostPanel): () => void {
  opener = open
  for (const listener of listeners) {
    listener()
  }
  return () => {
    if (opener === open) {
      opener = null
      for (const listener of listeners) {
        listener()
      }
    }
  }
}

/** The opener, or null while no panel shell is mounted. */
export function useAgentHostPanelOpener(): OpenAgentHostPanel | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => opener,
    () => opener
  )
}
