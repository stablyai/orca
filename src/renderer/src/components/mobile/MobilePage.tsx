import { useCallback, useEffect, useRef, useState } from 'react'
import QRCodeBrowser from 'qrcode/lib/browser'
import { toast } from 'sonner'
import { PhoneCarousel } from './PhoneCarousel'
import {
  HeroFlow,
  HeroIntro,
  HeroPaired,
  type PairedDevice,
  type Platform,
  type StepIndex
} from './MobileHero'
import {
  selectRefreshedNetworkAddress,
  type MobileNetworkInterface
} from '../settings/mobile-network-interface-selection'
import { useMobilePairingDevicePolling } from '../settings/mobile-pairing-device-polling'

type FlowStage = 'intro' | 'paired' | 'flow'

async function renderQrDataUrl(text: string): Promise<string> {
  return QRCodeBrowser.toDataURL(text, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 232
  })
}

export const PLATFORM_COPY: Record<
  Platform,
  { description: string; ctaLabel: string; url: string }
> = {
  ios: {
    description: 'Scan with your iPhone camera to open the App Store.',
    ctaLabel: 'Open App Store',
    url: 'https://apps.apple.com/app/orca-ide/id6766130217'
  },
  android: {
    description: 'Scan with your Android camera to download the latest APK from GitHub Releases.',
    ctaLabel: 'Download APK',
    url: 'https://github.com/stablyai/orca/releases/tag/mobile-v0.0.8'
  }
}

export default function MobilePage(): React.JSX.Element {
  // Why: stage starts unresolved so we don't flash the intro before we know
  // whether any devices are already paired.
  const [stage, setStage] = useState<FlowStage | null>(null)
  const [stepIdx, setStepIdx] = useState<StepIndex>(0)

  const [platform, setPlatform] = useState<Platform>('ios')
  const [installQrUrl, setInstallQrUrl] = useState<string | null>(null)

  const [pairQrDataUrl, setPairQrDataUrl] = useState<string | null>(null)
  const [pairingUrl, setPairingUrl] = useState<string | null>(null)
  const [pairLoading, setPairLoading] = useState(false)
  const [networkInterfaces, setNetworkInterfaces] = useState<MobileNetworkInterface[]>([])
  const [selectedAddress, setSelectedAddress] = useState<string | undefined>(undefined)
  const [refreshingNetworkInterfaces, setRefreshingNetworkInterfaces] = useState(false)
  const [devices, setDevices] = useState<PairedDevice[]>([])
  const [revokingDeviceIds, setRevokingDeviceIds] = useState<string[]>([])
  const [deviceCountAtPairStart, setDeviceCountAtPairStart] = useState<number | null>(null)
  const hasGeneratedRef = useRef(false)

  const loadDevices = useCallback(async (): Promise<PairedDevice[]> => {
    try {
      const result = await window.api.mobile.listDevices()
      setDevices(result.devices)
      return result.devices
    } catch {
      return []
    }
  }, [])

  // Why: pick the initial stage based on whether any devices are already
  // paired so returning users don't see the marketing intro every time.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const initialDevices = await loadDevices()
      if (cancelled) {
        return
      }
      setStage(initialDevices.length > 0 ? 'paired' : 'intro')
    })()
    return () => {
      cancelled = true
    }
  }, [loadDevices])

  const revokeDevice = useCallback(
    async (deviceId: string) => {
      setRevokingDeviceIds((prev) => [...prev, deviceId])
      try {
        await window.api.mobile.revokeDevice({ deviceId })
        const remaining = await loadDevices()
        toast.success('Device revoked')
        if (remaining.length === 0) {
          setStage('intro')
        }
      } catch {
        toast.error('Failed to revoke device')
      } finally {
        setRevokingDeviceIds((prev) => prev.filter((id) => id !== deviceId))
      }
    },
    [loadDevices]
  )

  // Why: render install QRs lazily — only after the user enters the flow,
  // and re-render whenever the platform changes.
  useEffect(() => {
    if (stage !== 'flow') {
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const dataUrl = await renderQrDataUrl(PLATFORM_COPY[platform].url)
        if (!cancelled) {
          setInstallQrUrl(dataUrl)
        }
      } catch {
        if (!cancelled) {
          setInstallQrUrl(null)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [platform, stage])

  const generatePairing = useCallback(
    async (rotate: boolean, addressOverride?: string) => {
      setPairLoading(true)
      try {
        const address = addressOverride ?? selectedAddress
        const result = await window.api.mobile.getPairingQR({
          ...(address ? { address } : {}),
          ...(rotate ? { rotate: true } : {})
        })
        if (result.available) {
          setPairQrDataUrl(result.qrDataUrl)
          setPairingUrl(result.pairingUrl)
          hasGeneratedRef.current = true
        } else {
          toast.error('WebSocket transport is not running')
        }
      } catch {
        toast.error('Failed to generate pairing code')
      } finally {
        setPairLoading(false)
      }
    },
    [selectedAddress]
  )

  const loadNetworkInterfaces = useCallback(async () => {
    setRefreshingNetworkInterfaces(true)
    try {
      const result = await window.api.mobile.listNetworkInterfaces()
      setNetworkInterfaces(result.interfaces)
      setSelectedAddress((current) => selectRefreshedNetworkAddress(current, result.interfaces))
    } catch {
      // Network list is non-critical; the QR will still mint with default routing.
    } finally {
      setRefreshingNetworkInterfaces(false)
    }
  }, [])

  useEffect(() => {
    if (stage !== 'flow') {
      return
    }
    void loadNetworkInterfaces()
  }, [stage, loadNetworkInterfaces])

  const handleAddressChange = useCallback(
    (address: string) => {
      setSelectedAddress(address)
      // Switching network must remint so the QR encodes the new endpoint.
      void generatePairing(true, address)
    },
    [generatePairing]
  )

  const copyPairingCode = useCallback(async () => {
    if (!pairingUrl) {
      return
    }
    try {
      await window.api.ui.writeClipboardText(pairingUrl)
      toast.success('Pairing code copied')
    } catch {
      toast.error('Failed to copy pairing code')
    }
  }, [pairingUrl])

  // Why: when Step 2 first becomes visible, mint a pairing offer so the
  // user sees a real QR immediately. Subsequent visits keep the existing
  // token unless they hit Regenerate.
  useEffect(() => {
    if (stage !== 'flow' || stepIdx !== 1 || hasGeneratedRef.current) {
      return
    }
    void generatePairing(false)
  }, [stage, stepIdx, generatePairing])

  // Why: poll for new pairings while the user is on Step 2 so we can
  // auto-transition to the paired summary the moment their phone connects.
  const polledLoadDevices = useCallback(async () => {
    await loadDevices()
  }, [loadDevices])

  // Why: poll for new pairings on Step 2 (waiting for the first pair) and
  // also on the paired view (so additional phones that finish pairing while
  // the user is reading the list show up without a manual refresh).
  useMobilePairingDevicePolling({
    deviceCountAtQr:
      (stage === 'flow' && stepIdx === 1) || stage === 'paired' ? deviceCountAtPairStart : null,
    currentDeviceCount: devices.length,
    loadDevices: polledLoadDevices
  })

  useEffect(() => {
    if (
      stage === 'flow' &&
      deviceCountAtPairStart !== null &&
      devices.length > deviceCountAtPairStart
    ) {
      setStage('paired')
    }
  }, [stage, devices.length, deviceCountAtPairStart])

  // Why: re-baseline the polling counter whenever the paired view is shown
  // so any subsequent pair (including ones initiated from a different
  // surface) triggers a refresh.
  useEffect(() => {
    if (stage === 'paired') {
      setDeviceCountAtPairStart(devices.length)
    }
  }, [stage, devices.length])

  const enterFlow = (): void => {
    setStepIdx(0)
    setDeviceCountAtPairStart(devices.length)
    setStage('flow')
  }

  // Why: from the paired summary, "Pair another device" jumps straight to
  // Step 2 since the app is presumably already installed on the user's phone.
  const pairAnotherDevice = (): void => {
    setStepIdx(1)
    setDeviceCountAtPairStart(devices.length)
    setStage('flow')
  }

  const handleBack = (): void => {
    if (stepIdx === 1) {
      setStepIdx(0)
    } else {
      setStage('intro')
    }
  }

  const handleContinue = (): void => {
    if (stepIdx === 0) {
      setStepIdx(1)
    }
  }

  const openInstallUrl = (): void => {
    void window.api.shell.openUrl(PLATFORM_COPY[platform].url)
  }

  const copyInstallUrl = async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(PLATFORM_COPY[platform].url)
      toast.success('Install link copied')
    } catch {
      toast.error('Failed to copy link')
    }
  }

  return (
    <div className="mobile-page-root">
      <section className="mp-hero">
        <div className="mp-hero-copy">
          {stage === null ? null : stage === 'intro' ? (
            <HeroIntro onStart={enterFlow} />
          ) : stage === 'paired' ? (
            <HeroPaired
              devices={devices}
              onPairAnother={pairAnotherDevice}
              onRevoke={(id) => void revokeDevice(id)}
              revokingDeviceIds={revokingDeviceIds}
            />
          ) : (
            <HeroFlow
              stepIdx={stepIdx}
              platform={platform}
              onPlatformChange={setPlatform}
              installQrUrl={installQrUrl}
              installCopy={PLATFORM_COPY[platform]}
              onOpenInstallUrl={openInstallUrl}
              onCopyInstallUrl={() => void copyInstallUrl()}
              pairQrDataUrl={pairQrDataUrl}
              pairingUrl={pairingUrl}
              pairLoading={pairLoading}
              onRegeneratePairing={() => void generatePairing(true)}
              onCopyPairingCode={() => void copyPairingCode()}
              networkInterfaces={networkInterfaces}
              selectedAddress={selectedAddress}
              onSelectedAddressChange={handleAddressChange}
              onRefreshNetworkInterfaces={() => void loadNetworkInterfaces()}
              refreshingNetworkInterfaces={refreshingNetworkInterfaces}
              onBack={handleBack}
              onContinue={handleContinue}
              onDone={devices.length > 0 ? () => setStage('paired') : undefined}
            />
          )}
        </div>

        <div className="mp-stage" aria-label="Phone preview">
          <PhoneCarousel />
        </div>
      </section>
    </div>
  )
}
