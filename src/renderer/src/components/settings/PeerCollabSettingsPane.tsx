import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { PeerCollabHostShareSection } from './PeerCollabHostShareSection'
import { PeerCollabDevicesSection } from './PeerCollabDevicesSection'
import {
  PeerCollabConnectedClientsSection,
  type ConnectedPeerClient,
  type HostTerminalOption
} from './PeerCollabConnectedClientsSection'
import { PeerCollabClientConnectSection } from './PeerCollabClientConnectSection'
import { usePeerCollabClientConnection } from './use-peer-collab-client-connection'
import type { PairedDevice } from './MobilePairedDevicesSection'
import {
  selectRefreshedNetworkAddress,
  type MobileNetworkInterface
} from './mobile-network-interface-selection'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { RemoteTerminalDialog } from '@/components/peer-collab/RemoteTerminalDialog'
export { getPeerCollabSettingsPaneSearchEntries } from './peer-collab-settings-search'

// Why: no push channel exists for peer connection changes yet, so the
// connected-clients list is kept fresh with a short poll while the pane is
// mounted (mirrors the phone-pairing device poll's interval approach).
const CONNECTED_CLIENTS_POLL_MS = 3000

export function PeerCollabSettingsPane(): React.JSX.Element {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [pairingUrl, setPairingUrl] = useState<string | null>(null)
  const [endpoint, setEndpoint] = useState<string | null>(null)
  // Why: a code backs exactly one client, so the displayed one is dropped once
  // its device pairs — leaving it on screen invites handing out a dead code.
  const [offerDeviceId, setOfferDeviceId] = useState<string | null>(null)
  const [offerConsumed, setOfferConsumed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [qrEnlarged, setQrEnlarged] = useState(false)
  const [codeCopied, setCodeCopied] = useState(false)
  const [networkInterfaces, setNetworkInterfaces] = useState<MobileNetworkInterface[]>([])
  const [selectedAddress, setSelectedAddress] = useState<string | undefined>(undefined)
  const [devices, setDevices] = useState<PairedDevice[]>([])
  const [connectedClients, setConnectedClients] = useState<ConnectedPeerClient[]>([])
  const [exclusiveInputFloor, setExclusiveInputFloorState] = useState(false)
  // Why: distinct from `hostTerminals` in usePeerCollabClientConnection, which is the
  // *remote* host's terminals seen while connected as a peer client; this is this
  // desktop's own terminals, used for the grant picker when acting as the host.
  const [ownTerminals, setOwnTerminals] = useState<HostTerminalOption[]>([])
  const {
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
  } = usePeerCollabClientConnection()
  const codeCopiedResetTimerRef = useRef<number | null>(null)
  const selectedAddressRef = useRef<string | undefined>(selectedAddress)
  const mountedRef = useMountedRef()

  const clearCodeCopiedResetTimer = useCallback((): void => {
    if (codeCopiedResetTimerRef.current !== null) {
      window.clearTimeout(codeCopiedResetTimerRef.current)
      codeCopiedResetTimerRef.current = null
    }
  }, [])

  const loadNetworkInterfaces = useCallback(async () => {
    try {
      const result = await window.api.mobile.listNetworkInterfaces()
      if (!mountedRef.current) {
        return
      }
      setNetworkInterfaces(result.interfaces)
      const nextAddress = selectRefreshedNetworkAddress(
        selectedAddressRef.current,
        result.interfaces
      )
      if (nextAddress !== selectedAddressRef.current) {
        selectedAddressRef.current = nextAddress
        setSelectedAddress(nextAddress)
      }
    } catch {
      // Non-critical — the picker just stays empty until the next refresh.
    }
  }, [mountedRef])

  const loadDevices = useCallback(async () => {
    try {
      const result = await window.api.peerCollab.listDevices()
      if (mountedRef.current) {
        setDevices(result.devices)
      }
    } catch {
      // Silently fail — device list is non-critical
    }
  }, [mountedRef])

  const loadConnectedClients = useCallback(async () => {
    try {
      const result = await window.api.peerCollab.listConnectedClients()
      if (mountedRef.current) {
        setConnectedClients(result.clients)
      }
    } catch {
      // Silently fail — polled again shortly
    }
  }, [mountedRef])

  const loadOwnTerminals = useCallback(async () => {
    try {
      const result = await window.api.peerCollab.listHostTerminals()
      if (mountedRef.current) {
        setOwnTerminals(result.terminals)
      }
    } catch {
      // Silently fail — polled again shortly
    }
  }, [mountedRef])

  const generateOffer = useCallback(
    async (opts: { rotate?: boolean } = {}) => {
      setLoading(true)
      try {
        const result = await window.api.peerCollab.getPairingOffer({
          ...(selectedAddress ? { address: selectedAddress } : {}),
          ...(opts.rotate ? { rotate: true } : {})
        })
        if (!mountedRef.current) {
          return
        }
        if (result.available) {
          setQrDataUrl(result.qrDataUrl)
          setPairingUrl(result.pairingUrl)
          setEndpoint(result.endpoint)
          setOfferDeviceId(result.deviceId)
          setOfferConsumed(false)
          clearCodeCopiedResetTimer()
          setCodeCopied(false)
          void loadDevices()
        } else {
          toast.error(
            translate(
              'auto.components.settings.PeerCollabSettingsPane.wsNotRunning',
              'WebSocket transport is not running'
            )
          )
        }
      } catch {
        if (mountedRef.current) {
          toast.error(
            translate(
              'auto.components.settings.PeerCollabSettingsPane.generateFailed',
              'Failed to generate pairing code'
            )
          )
        }
      } finally {
        if (mountedRef.current) {
          setLoading(false)
        }
      }
    },
    [clearCodeCopiedResetTimer, loadDevices, mountedRef, selectedAddress]
  )

  const handleSelectedAddressChange = useCallback((address: string): void => {
    setSelectedAddress(address)
    selectedAddressRef.current = address
    // A displayed code encodes the previous address — drop it so the user
    // doesn't hand out a code for an interface they just switched away from.
    setQrDataUrl(null)
    setPairingUrl(null)
    setEndpoint(null)
    setOfferDeviceId(null)
    setOfferConsumed(false)
  }, [])

  // Why: the device turns up in the paired list the moment a client authenticates
  // with the displayed code, which is the signal that the code is spent.
  useEffect(() => {
    if (!offerDeviceId || !devices.some((device) => device.deviceId === offerDeviceId)) {
      return
    }
    setQrDataUrl(null)
    setPairingUrl(null)
    setEndpoint(null)
    setOfferDeviceId(null)
    setOfferConsumed(true)
  }, [devices, offerDeviceId])

  const toggleExclusiveInputFloor = useCallback(async () => {
    const next = !exclusiveInputFloor
    setExclusiveInputFloorState(next)
    try {
      const result = await window.api.peerCollab.setExclusiveInputFloor({ enabled: next })
      if (mountedRef.current) {
        setExclusiveInputFloorState(result.enabled)
      }
    } catch {
      if (mountedRef.current) {
        setExclusiveInputFloorState(!next)
      }
    }
  }, [exclusiveInputFloor, mountedRef])

  useEffect(() => {
    void loadNetworkInterfaces()
    void loadDevices()
    void loadConnectedClients()
    void loadOwnTerminals()
    void window.api.peerCollab.getExclusiveInputFloor().then(({ enabled }) => {
      if (mountedRef.current) {
        setExclusiveInputFloorState(enabled)
      }
    })
  }, [loadNetworkInterfaces, loadDevices, loadConnectedClients, loadOwnTerminals, mountedRef])

  useEffect(() => {
    const timer = window.setInterval(() => void loadConnectedClients(), CONNECTED_CLIENTS_POLL_MS)
    return () => window.clearInterval(timer)
  }, [loadConnectedClients])

  useEffect(() => {
    const timer = window.setInterval(() => void loadOwnTerminals(), CONNECTED_CLIENTS_POLL_MS)
    return () => window.clearInterval(timer)
  }, [loadOwnTerminals])

  async function revokeDevice(deviceId: string) {
    try {
      const { revoked } = await window.api.peerCollab.disconnectClient({
        deviceId,
        revokeDevice: true
      })
      if (!revoked) {
        throw new Error('peerCollab.disconnectClient returned revoked=false')
      }
      await Promise.all([loadDevices(), loadConnectedClients()])
      if (mountedRef.current) {
        toast.success(
          translate(
            'auto.components.settings.PeerCollabSettingsPane.deviceRevoked',
            'Device revoked'
          )
        )
      }
    } catch {
      if (mountedRef.current) {
        toast.error(
          translate(
            'auto.components.settings.PeerCollabSettingsPane.revokeFailed',
            'Failed to revoke device'
          )
        )
      }
    }
  }

  async function disconnectClient(deviceId: string, revokeDevice: boolean) {
    try {
      await window.api.peerCollab.disconnectClient({ deviceId, revokeDevice })
      await Promise.all([loadConnectedClients(), loadDevices()])
    } catch {
      if (mountedRef.current) {
        toast.error(
          translate(
            'auto.components.settings.PeerCollabSettingsPane.disconnectFailed',
            'Failed to disconnect client'
          )
        )
      }
    }
  }

  async function setGrantedTerminals(deviceId: string, handles: string[]) {
    // Why: optimistic update so the checkbox reflects the click immediately;
    // the next poll reconciles with the persisted device-registry state.
    setConnectedClients((current) =>
      current.map((client) =>
        client.deviceId === deviceId ? { ...client, grantedTerminals: handles } : client
      )
    )
    try {
      await window.api.peerCollab.setGrantedTerminals({ deviceId, handles })
    } catch {
      if (mountedRef.current) {
        toast.error(
          translate(
            'auto.components.settings.PeerCollabSettingsPane.grantTerminalsFailed',
            'Failed to update shared terminals'
          )
        )
      }
    } finally {
      await loadConnectedClients()
    }
  }

  return (
    <div className="space-y-6">
      <PeerCollabHostShareSection
        networkInterfaces={networkInterfaces}
        selectedAddress={selectedAddress}
        onSelectedAddressChange={handleSelectedAddressChange}
        qrDataUrl={qrDataUrl}
        pairingUrl={pairingUrl}
        endpoint={endpoint}
        loading={loading}
        offerConsumed={offerConsumed}
        qrEnlarged={qrEnlarged}
        codeCopied={codeCopied}
        onGenerate={() => void generateOffer({ rotate: qrDataUrl != null })}
        onQrEnlargedChange={setQrEnlarged}
        onCodeCopiedChange={setCodeCopied}
        onClearCodeCopiedTimer={clearCodeCopiedResetTimer}
      />

      <PeerCollabDevicesSection
        devices={devices}
        hasQrCode={qrDataUrl != null}
        onRevokeDevice={(deviceId) => void revokeDevice(deviceId)}
        // Why: reuses the already-polled connectedClients so "connected now" doesn't need its own poll.
        connectedDeviceIds={new Set(connectedClients.map((client) => client.deviceId))}
      />

      <PeerCollabConnectedClientsSection
        exclusiveInputFloor={exclusiveInputFloor}
        onToggleExclusiveInputFloor={() => void toggleExclusiveInputFloor()}
        connectedClients={connectedClients}
        onDisconnectClient={(deviceId, revoke) => void disconnectClient(deviceId, revoke)}
        hostTerminals={ownTerminals}
        onSetGrantedTerminals={(deviceId, handles) => void setGrantedTerminals(deviceId, handles)}
      />

      <PeerCollabClientConnectSection
        clientPairingCode={clientPairingCode}
        onClientPairingCodeChange={setClientPairingCode}
        clientDisplayName={clientDisplayName}
        onClientDisplayNameChange={setClientDisplayName}
        clientStatus={clientStatus}
        clientConnectBusy={clientConnectBusy}
        onConnect={() => void connectAsClient()}
        onDisconnect={() => void disconnectAsClient()}
        hostTerminals={hostTerminals}
        onOpenTerminal={setOpenRemoteTerminal}
        savedPairing={savedPairing}
        onConnectSaved={() => void connectSavedAsClient()}
        onForgetSavedPairing={() => void forgetSavedPairing()}
      />

      <RemoteTerminalDialog
        target={openRemoteTerminal}
        hostLabel={clientStatus.endpoint ?? ''}
        clientStatus={clientStatus}
        onOpenChange={(open) => {
          if (!open) {
            setOpenRemoteTerminal(null)
          }
        }}
      />
    </div>
  )
}
