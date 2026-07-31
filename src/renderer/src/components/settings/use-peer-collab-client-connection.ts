import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import type { RuntimeTerminalListResult } from '../../../../shared/runtime-types'
import type { PeerClientStatus } from '../../../../shared/peer-client-status'
import type { RemoteTerminalDialogTarget } from '@/components/peer-collab/RemoteTerminalDialog'
import { usePeerCollabSavedPairing, type SavedPeerPairing } from './use-peer-collab-saved-pairing'
import { isTerminalListResult } from './peer-collab-terminal-list-guard'

const HOST_TERMINALS_POLL_MS = 3000

export type PeerCollabClientConnectionHook = {
  hostTerminals: RuntimeTerminalListResult['terminals']
  clientPairingCode: string
  setClientPairingCode: (code: string) => void
  clientDisplayName: string
  setClientDisplayName: (name: string) => void
  clientStatus: PeerClientStatus
  clientConnectBusy: boolean
  connectAsClient: () => Promise<void>
  connectSavedAsClient: () => Promise<void>
  disconnectAsClient: () => Promise<void>
  savedPairing: SavedPeerPairing | null
  forgetSavedPairing: () => Promise<void>
  openRemoteTerminal: RemoteTerminalDialogTarget | null
  setOpenRemoteTerminal: (target: RemoteTerminalDialogTarget | null) => void
}

// Why: isolates the peer-client connect/disconnect flow, its host-terminal poll, and the
// remote-terminal dialog target from PeerCollabSettingsPane so the pane stays under the
// tsx line budget as this feature grows.
export function usePeerCollabClientConnection(): PeerCollabClientConnectionHook {
  const mountedRef = useMountedRef()
  const {
    savedPairing,
    refresh: refreshSavedPairing,
    connectSaved,
    forget: forgetSavedPairing
  } = usePeerCollabSavedPairing()
  const [hostTerminals, setHostTerminals] = useState<RuntimeTerminalListResult['terminals']>([])
  const [clientPairingCode, setClientPairingCode] = useState('')
  const [clientDisplayName, setClientDisplayName] = useState('')
  const [clientStatus, setClientStatus] = useState<PeerClientStatus>({
    state: 'closed',
    endpoint: null,
    reconnectAttempt: 0,
    lastErrorReason: null
  })
  const [clientConnectBusy, setClientConnectBusy] = useState(false)
  const [openRemoteTerminal, setOpenRemoteTerminal] = useState<RemoteTerminalDialogTarget | null>(
    null
  )

  const loadHostTerminals = useCallback(async () => {
    try {
      const result = await window.api.peerClient.listHostTerminals()
      if (mountedRef.current && result.ok && isTerminalListResult(result.terminals)) {
        setHostTerminals(result.terminals.terminals)
      }
    } catch {
      // Silently fail — polled again shortly while connected
    }
  }, [mountedRef])

  const notifyClientConnectFailure = useCallback(
    (reason: string) => {
      if (mountedRef.current) {
        toast.error(
          translate(
            'auto.components.settings.PeerCollabSettingsPane.clientConnectFailed',
            'Failed to connect: {{reason}}',
            { reason }
          )
        )
      }
    },
    [mountedRef]
  )

  const runClientConnect = useCallback(
    async (connectFn: () => Promise<{ ok: true } | { ok: false; reason: string }>) => {
      setClientConnectBusy(true)
      try {
        const result = await connectFn()
        if (!result.ok) {
          notifyClientConnectFailure(result.reason)
        }
      } catch {
        notifyClientConnectFailure('unknown_error')
      } finally {
        if (mountedRef.current) {
          setClientConnectBusy(false)
        }
      }
    },
    [mountedRef, notifyClientConnectFailure]
  )

  const connectAsClient = useCallback(
    () =>
      runClientConnect(() =>
        window.api.peerClient.connect({
          pairingCode: clientPairingCode,
          displayName: clientDisplayName
        })
      ),
    [runClientConnect, clientPairingCode, clientDisplayName]
  )

  const connectSavedAsClient = useCallback(
    () => runClientConnect(connectSaved),
    [runClientConnect, connectSaved]
  )

  const disconnectAsClient = useCallback(async () => {
    await window.api.peerClient.disconnect()
    if (mountedRef.current) {
      setHostTerminals([])
    }
  }, [mountedRef])

  useEffect(() => {
    void window.api.peerClient.getStatus().then((status) => {
      if (mountedRef.current) {
        setClientStatus(status)
      }
    })
    void window.api.peerClient.getDefaultDisplayName().then(({ name }) => {
      if (mountedRef.current) {
        setClientDisplayName(name)
      }
    })
    return window.api.peerClient.onStatusChanged((status) => setClientStatus(status))
  }, [mountedRef])

  useEffect(() => {
    if (clientStatus.state !== 'connected') {
      return
    }
    void loadHostTerminals()
    const timer = window.setInterval(() => void loadHostTerminals(), HOST_TERMINALS_POLL_MS)
    return () => window.clearInterval(timer)
  }, [clientStatus.state, loadHostTerminals])

  useEffect(() => {
    if (clientStatus.state === 'closed') {
      // Why: a lost host connection leaves the stream dead — close the dialog instead of showing a frozen terminal.
      setOpenRemoteTerminal(null)
    } else if (clientStatus.state === 'connected') {
      // Why: a fresh success may have just persisted a new saved pairing on the main side.
      void refreshSavedPairing()
    }
  }, [clientStatus.state, refreshSavedPairing])

  return {
    hostTerminals,
    clientPairingCode,
    setClientPairingCode,
    clientDisplayName,
    setClientDisplayName,
    clientStatus,
    clientConnectBusy,
    connectAsClient,
    connectSavedAsClient,
    disconnectAsClient,
    savedPairing,
    forgetSavedPairing,
    openRemoteTerminal,
    setOpenRemoteTerminal
  }
}
