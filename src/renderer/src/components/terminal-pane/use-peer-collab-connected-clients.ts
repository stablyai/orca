import { useCallback, useEffect, useState } from 'react'
import type { ConnectedPeerClient } from '@/components/settings/PeerCollabConnectedClientsSection'

// Why: no push channel for peer connection changes yet; mirrors RemoteTerminalPanel's SUBSCRIBERS_POLL_MS.
const CONNECTED_CLIENTS_POLL_MS = 4000

export type PeerCollabConnectedClients = {
  clients: ConnectedPeerClient[]
  // Why: grant toggles should reflect immediately instead of waiting out the poll interval.
  refresh: () => Promise<void>
}

// Why: Terminal.tsx keeps multiple worktree tabs mounted simultaneously (background
// parking), each rendering its own TerminalPaneHeaderOverlay; a module-level singleton
// keeps the host-wide connected-clients poll to one interval regardless of mount count.
let sharedClients: ConnectedPeerClient[] = []
let sharedTimer: number | null = null
let sharedPollPromise: Promise<void> | null = null
const subscribers = new Set<(clients: ConnectedPeerClient[]) => void>()

async function pollSharedClients(): Promise<void> {
  if (sharedPollPromise) {
    return sharedPollPromise
  }
  sharedPollPromise = (async () => {
    const result = await window.api?.peerCollab?.listConnectedClients()
    if (result) {
      sharedClients = result.clients
      for (const subscriber of subscribers) {
        subscriber(sharedClients)
      }
    }
  })()
  try {
    await sharedPollPromise
  } finally {
    sharedPollPromise = null
  }
}

function subscribeToSharedClients(
  subscriber: (clients: ConnectedPeerClient[]) => void
): () => void {
  subscribers.add(subscriber)
  if (sharedTimer === null) {
    sharedTimer = window.setInterval(() => void pollSharedClients(), CONNECTED_CLIENTS_POLL_MS)
  }
  return () => {
    subscribers.delete(subscriber)
    if (subscribers.size === 0 && sharedTimer !== null) {
      window.clearInterval(sharedTimer)
      sharedTimer = null
    }
  }
}

/**
 * Single host-wide poll of connected peer viewers, shared across every mounted
 * TerminalPaneHeaderOverlay (splits within a tab and background-parked tabs alike)
 * instead of each instance polling independently.
 */
export function usePeerCollabConnectedClients(): PeerCollabConnectedClients {
  const [clients, setClients] = useState<ConnectedPeerClient[]>(sharedClients)

  useEffect(() => {
    setClients(sharedClients)
    const unsubscribe = subscribeToSharedClients(setClients)
    void pollSharedClients()
    return unsubscribe
  }, [])

  const refresh = useCallback(() => pollSharedClients(), [])

  return { clients, refresh }
}
