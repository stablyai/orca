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
import { usePeerCollabClientConnection } from '@/components/peer-collab/use-peer-collab-client-connection'
import type { PairedDevice } from './MobilePairedDevicesSection'
import {
  selectRefreshedNetworkAddress,
  type MobileNetworkInterface
} from './mobile-network-interface-selection'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
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
  // Why: grants key off deviceId in the registry, so the paired-devices list manages them for offline devices too.
  const [deviceGrants, setDeviceGrants] = useState<Record<string, string[]>>({})
  const [connectedClients, setConnectedClients] = useState<ConnectedPeerClient[]>([])
  const [exclusiveInputFloor, setExclusiveInputFloorState] = useState(false)
  const [hostEnabled, setHostEnabledState] = useState(false)
  const [clientEnabled, setClientEnabledState] = useState(false)
  // Why: distinct from each host's `terminals` in usePeerCollabClientConnection, which are
  // *remote* hosts' terminals seen while connected as a peer client; this is this
  // desktop's own terminals, used for the grant picker when acting as the host.
  const [ownTerminals, setOwnTerminals] = useState<HostTerminalOption[]>([])
  const {
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
  } = usePeerCollabClientConnection()
  const openPeersPage = useAppStore((s) => s.openPeersPage)
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
        setDeviceGrants(
          Object.fromEntries(result.devices.map((d) => [d.deviceId, d.grantedTerminals]))
        )
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

  const toggleHostEnabled = useCallback(async () => {
    const next = !hostEnabled
    setHostEnabledState(next)
    try {
      const result = await window.api.peerCollab.setHostEnabled({ enabled: next })
      if (mountedRef.current) {
        setHostEnabledState(result.enabled)
      }
    } catch {
      if (mountedRef.current) {
        setHostEnabledState(!next)
      }
    }
  }, [hostEnabled, mountedRef])

  const toggleClientEnabled = useCallback(async () => {
    const next = !clientEnabled
    setClientEnabledState(next)
    try {
      const result = await window.api.peerClient.setClientEnabled({ enabled: next })
      if (mountedRef.current) {
        setClientEnabledState(result.enabled)
      }
    } catch {
      if (mountedRef.current) {
        setClientEnabledState(!next)
      }
    }
  }, [clientEnabled, mountedRef])

  useEffect(() => {
    void loadNetworkInterfaces()
    void loadDevices()
    void window.api.peerCollab.getExclusiveInputFloor().then(({ enabled }) => {
      if (mountedRef.current) {
        setExclusiveInputFloorState(enabled)
      }
    })
    void window.api.peerCollab.getHostEnabled().then(({ enabled }) => {
      if (mountedRef.current) {
        setHostEnabledState(enabled)
      }
    })
    void window.api.peerClient.getClientEnabled().then(({ enabled }) => {
      if (mountedRef.current) {
        setClientEnabledState(enabled)
      }
    })
  }, [loadNetworkInterfaces, loadDevices, mountedRef])

  // Why: polling only matters while hosting is on. Devices ride the same poll —
  // pairing lands registry-side first, and the code-consumed watcher above only
  // fires when the devices list refreshes.
  useEffect(() => {
    if (!hostEnabled) {
      setConnectedClients([])
      return
    }
    const poll = (): void => void Promise.all([loadConnectedClients(), loadDevices()])
    poll()
    const timer = window.setInterval(poll, CONNECTED_CLIENTS_POLL_MS)
    return () => window.clearInterval(timer)
  }, [hostEnabled, loadConnectedClients, loadDevices])

  useEffect(() => {
    if (!hostEnabled) {
      setOwnTerminals([])
      return
    }
    void loadOwnTerminals()
    const timer = window.setInterval(() => void loadOwnTerminals(), CONNECTED_CLIENTS_POLL_MS)
    return () => window.clearInterval(timer)
  }, [hostEnabled, loadOwnTerminals])

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

  async function disconnectClient(deviceId: string) {
    try {
      await window.api.peerCollab.disconnectClient({ deviceId, revokeDevice: false })
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
    setDeviceGrants((current) => ({ ...current, [deviceId]: handles }))
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
      await Promise.all([loadConnectedClients(), loadDevices()])
    }
  }

  return (
    <div className="space-y-6">
      {/* Why: hosting and connecting-out are independent roles a desktop can hold
          at once — separate cards keep each role's toggle scoped to its own box. */}
      <div className="max-w-3xl space-y-6 rounded-xl border border-border/50 bg-card/50 px-7 py-6 shadow-xs">
        <h3 className="text-sm font-semibold text-foreground">
          {translate('auto.components.settings.PeerCollabSettingsPane.hostGroupTitle', 'Host')}
        </h3>
        <PeerCollabHostShareSection
          hostEnabled={hostEnabled}
          onToggleHostEnabled={() => void toggleHostEnabled()}
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

        {hostEnabled ? (
          <PeerCollabDevicesSection
            devices={devices}
            hasQrCode={qrDataUrl != null}
            onRevokeDevice={(deviceId) => void revokeDevice(deviceId)}
            connectedClients={connectedClients}
            grantedTerminalsByDeviceId={deviceGrants}
            hostTerminals={ownTerminals}
            onSetGrantedTerminals={(deviceId, handles) =>
              void setGrantedTerminals(deviceId, handles)
            }
          />
        ) : null}

        {hostEnabled ? (
          <PeerCollabConnectedClientsSection
            exclusiveInputFloor={exclusiveInputFloor}
            onToggleExclusiveInputFloor={() => void toggleExclusiveInputFloor()}
            connectedClients={connectedClients}
            onDisconnectClient={(deviceId) => void disconnectClient(deviceId)}
            hostTerminals={ownTerminals}
            onSetGrantedTerminals={(deviceId, handles) =>
              void setGrantedTerminals(deviceId, handles)
            }
          />
        ) : null}
      </div>

      <div className="max-w-3xl space-y-6 rounded-xl border border-border/50 bg-card/50 px-7 py-6 shadow-xs">
        <h3 className="text-sm font-semibold text-foreground">
          {translate('auto.components.settings.PeerCollabSettingsPane.clientGroupTitle', 'Client')}
        </h3>
        <PeerCollabClientConnectSection
          hostNames={hostNames}
          onRenameHost={(hostId, name) => void renameHost(hostId, name)}
          clientEnabled={clientEnabled}
          onToggleClientEnabled={() => void toggleClientEnabled()}
          clientPairingCode={clientPairingCode}
          onClientPairingCodeChange={setClientPairingCode}
          clientDisplayName={clientDisplayName}
          onClientDisplayNameChange={setClientDisplayName}
          clientConnectBusy={clientConnectBusy}
          onConnect={() => void connectAsClient()}
          hosts={hosts}
          onDisconnectHost={(hostId) => void disconnectAsClient(hostId)}
          onOpenTerminal={(target) => openPeersPage(target)}
          savedPairings={savedPairings}
          onConnectSaved={(hostId) => void connectSavedAsClient(hostId)}
          onForgetSavedPairing={(hostId) => void forgetSavedPairing(hostId)}
        />
      </div>
    </div>
  )
}
