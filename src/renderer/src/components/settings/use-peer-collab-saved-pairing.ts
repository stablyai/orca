import { useCallback, useEffect, useState } from 'react'
import type { SavedPeerPairing } from '../../../../shared/peer-client-status'

export type { SavedPeerPairing }

export type PeerCollabSavedPairingHook = {
  savedPairings: SavedPeerPairing[]
  refresh: () => Promise<void>
  connectSaved: (
    hostId: string
  ) => Promise<{ ok: true; hostId: string } | { ok: false; reason: string }>
  forget: (hostId: string) => Promise<void>
}

// Why: isolates the saved-pairing IPC round trips from the client-connect surfaces
// (Settings pane, connection hook) — the IPC layer tracks a saved pairing per host,
// so this exposes the full list rather than collapsing it to one.
export function usePeerCollabSavedPairing(): PeerCollabSavedPairingHook {
  const [savedPairings, setSavedPairings] = useState<SavedPeerPairing[]>([])

  const refresh = useCallback(async () => {
    const saved = await window.api.peerClient.listSavedPairings()
    setSavedPairings(saved)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const connectSaved = useCallback(
    (hostId: string) => window.api.peerClient.connectSaved({ hostId }),
    []
  )

  const forget = useCallback(async (hostId: string) => {
    await window.api.peerClient.forgetSavedPairing({ hostId })
    setSavedPairings((prev) => prev.filter((pairing) => pairing.hostId !== hostId))
  }, [])

  return { savedPairings, refresh, connectSaved, forget }
}
