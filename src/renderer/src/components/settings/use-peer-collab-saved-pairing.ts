import { useCallback, useEffect, useState } from 'react'
import type { SavedPeerPairing } from '../../../../shared/peer-client-status'

export type { SavedPeerPairing }

export type PeerCollabSavedPairingHook = {
  savedPairing: SavedPeerPairing | null
  refresh: () => Promise<void>
  connectSaved: () => Promise<{ ok: true } | { ok: false; reason: string }>
  forget: () => Promise<void>
}

// Why: isolates the saved-pairing IPC round trips from PeerCollabSettingsPane
// so that pane stays under the tsx line budget as this feature grows.
export function usePeerCollabSavedPairing(): PeerCollabSavedPairingHook {
  const [savedPairing, setSavedPairing] = useState<SavedPeerPairing | null>(null)

  const refresh = useCallback(async () => {
    const saved = await window.api.peerClient.getSavedPairing()
    setSavedPairing(saved)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const connectSaved = useCallback(() => window.api.peerClient.connectSaved(), [])

  const forget = useCallback(async () => {
    await window.api.peerClient.forgetSavedPairing()
    setSavedPairing(null)
  }, [])

  return { savedPairing, refresh, connectSaved, forget }
}
