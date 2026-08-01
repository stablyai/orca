import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import type { RuntimeTerminalListResult } from '../../../../shared/runtime-types'
import type {
  PeerClientStatus,
  PeerClientStatusWithHost
} from '../../../../shared/peer-client-status'
import {
  usePeerCollabSavedPairing,
  type SavedPeerPairing
} from '../settings/use-peer-collab-saved-pairing'
import { isTerminalListResult } from '../settings/peer-collab-terminal-list-guard'

const HOST_TERMINALS_POLL_MS = 3000

export type PeerHostConnection = {
  hostId: string
  endpoint: string | null
  /** User-assigned alias for this host; falls back to the endpoint in UI. */
  name?: string | null
  status: PeerClientStatus
  terminals: RuntimeTerminalListResult['terminals']
}

export type PeerCollabClientConnectionHook = {
  hosts: PeerHostConnection[]
  hostNames: Record<string, string>
  renameHost: (hostId: string, name: string) => Promise<void>
  clientPairingCode: string
  setClientPairingCode: (code: string) => void
  clientDisplayName: string
  setClientDisplayName: (name: string) => void
  clientConnectBusy: boolean
  connectAsClient: () => Promise<void>
  connectSavedAsClient: (hostId: string) => Promise<void>
  disconnectAsClient: (hostId: string) => Promise<void>
  savedPairings: SavedPeerPairing[]
  forgetSavedPairing: (hostId: string) => Promise<void>
}

// Why: isolates the peer-client connect/disconnect flow and its per-host terminal poll
// from any one surface — both the Settings pane's connect form and the Peers page's
// terminal viewer consume this same live state. A client can hold several simultaneous
// host connections, so state here is keyed by hostId rather than assuming exactly one.
export function usePeerCollabClientConnection(): PeerCollabClientConnectionHook {
  const mountedRef = useMountedRef()
  const {
    savedPairings,
    refresh: refreshSavedPairings,
    connectSaved,
    forget: forgetSavedPairing
  } = usePeerCollabSavedPairing()
  const [statusesByHost, setStatusesByHost] = useState<Record<string, PeerClientStatus>>({})
  const [hostNames, setHostNames] = useState<Record<string, string>>({})
  const [terminalsByHost, setTerminalsByHost] = useState<
    Record<string, RuntimeTerminalListResult['terminals']>
  >({})
  const [clientPairingCode, setClientPairingCode] = useState('')
  const [clientDisplayName, setClientDisplayName] = useState('')
  const [clientConnectBusy, setClientConnectBusy] = useState(false)

  const loadHostTerminals = useCallback(
    async (hostId: string) => {
      try {
        const result = await window.api.peerClient.listHostTerminals({ hostId })
        if (mountedRef.current && result.ok && isTerminalListResult(result.terminals)) {
          const { terminals } = result.terminals
          setTerminalsByHost((prev) => ({ ...prev, [hostId]: terminals }))
        }
      } catch {
        // Silently fail — polled again shortly while connected
      }
    },
    [mountedRef]
  )

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
    async (
      connectFn: () => Promise<{ ok: true; hostId: string } | { ok: false; reason: string }>
    ) => {
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
    (hostId: string) => runClientConnect(() => connectSaved(hostId)),
    [runClientConnect, connectSaved]
  )

  const disconnectAsClient = useCallback(
    async (hostId: string) => {
      await window.api.peerClient.disconnect({ hostId })
      if (mountedRef.current) {
        setStatusesByHost((prev) => {
          const next = { ...prev }
          delete next[hostId]
          return next
        })
        setTerminalsByHost((prev) => {
          const next = { ...prev }
          delete next[hostId]
          return next
        })
      }
    },
    [mountedRef]
  )

  const renameHost = useCallback(
    async (hostId: string, name: string) => {
      const { names } = await window.api.peerClient.setHostName({ hostId, name })
      if (mountedRef.current) {
        setHostNames(names)
      }
    },
    [mountedRef]
  )

  useEffect(() => {
    // Why: host components (Sidebar, Terminal) mount this hook in environments
    // whose window.api mock predates peer collab — degrade to inert, not crash.
    const peerClient = window.api?.peerClient
    if (!peerClient) {
      return
    }
    void peerClient.getStatuses().then((statuses) => {
      if (!mountedRef.current) {
        return
      }
      setStatusesByHost((prev) => {
        const next = { ...prev }
        for (const status of statuses) {
          next[status.hostId] = status
        }
        return next
      })
    })
    void peerClient.getDefaultDisplayName().then(({ name }) => {
      if (mountedRef.current) {
        setClientDisplayName(name)
      }
    })
    void peerClient.getHostNames().then(({ names }) => {
      if (mountedRef.current) {
        setHostNames(names)
      }
    })
  }, [mountedRef])

  useEffect(() => {
    return window.api?.peerClient?.onStatusChanged((status: PeerClientStatusWithHost) => {
      setStatusesByHost((prev) => ({ ...prev, [status.hostId]: status }))
    })
  }, [])

  useEffect(() => {
    const connectedHostIds = Object.entries(statusesByHost)
      .filter(([, status]) => status.state === 'connected')
      .map(([hostId]) => hostId)
    if (connectedHostIds.length === 0) {
      return
    }
    const poll = (): void => {
      for (const hostId of connectedHostIds) {
        void loadHostTerminals(hostId)
      }
    }
    poll()
    const timer = window.setInterval(poll, HOST_TERMINALS_POLL_MS)
    return () => window.clearInterval(timer)
  }, [statusesByHost, loadHostTerminals])

  useEffect(() => {
    if (Object.values(statusesByHost).some((status) => status.state === 'connected')) {
      // Why: a fresh success may have just persisted a new saved pairing on the main side.
      void refreshSavedPairings()
    }
  }, [statusesByHost, refreshSavedPairings])

  // Memoized so consumers depending on `hosts` (e.g. PeersPage's selection-recovery effect)
  // don't re-run on every render when neither statuses nor terminals actually changed.
  const hosts: PeerHostConnection[] = useMemo(
    () =>
      Object.entries(statusesByHost).map(([hostId, status]) => ({
        hostId,
        endpoint: status.endpoint,
        name: hostNames[hostId] ?? null,
        status,
        terminals: terminalsByHost[hostId] ?? []
      })),
    [statusesByHost, terminalsByHost, hostNames]
  )

  return {
    hosts,
    hostNames,
    renameHost,
    clientPairingCode,
    setClientPairingCode,
    clientDisplayName,
    setClientDisplayName,
    clientConnectBusy,
    connectAsClient,
    connectSavedAsClient,
    disconnectAsClient,
    savedPairings,
    forgetSavedPairing
  }
}
