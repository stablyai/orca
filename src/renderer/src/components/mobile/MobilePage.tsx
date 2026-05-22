import { useCallback, useEffect, useRef, useState } from 'react'
import QRCodeBrowser from 'qrcode/lib/browser'
import { toast } from 'sonner'
import { PhoneCarousel } from './PhoneCarousel'
import { HeroFlow, HeroIntro, type Platform, type StepIndex } from './MobileHero'

type FlowStage = 'intro' | 'flow'

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
  const [stage, setStage] = useState<FlowStage>('intro')
  const [stepIdx, setStepIdx] = useState<StepIndex>(0)

  const [platform, setPlatform] = useState<Platform>('ios')
  const [installQrUrl, setInstallQrUrl] = useState<string | null>(null)

  const [pairQrDataUrl, setPairQrDataUrl] = useState<string | null>(null)
  const [pairEndpoint, setPairEndpoint] = useState<string | null>(null)
  const [pairingUrl, setPairingUrl] = useState<string | null>(null)
  const [pairLoading, setPairLoading] = useState(false)
  const hasGeneratedRef = useRef(false)

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

  const generatePairing = useCallback(async (rotate: boolean) => {
    setPairLoading(true)
    try {
      const result = await window.api.mobile.getPairingQR(rotate ? { rotate: true } : {})
      if (result.available) {
        setPairQrDataUrl(result.qrDataUrl)
        setPairEndpoint(result.endpoint)
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
  }, [])

  // Why: when Step 2 first becomes visible, mint a pairing offer so the
  // user sees a real QR immediately. Subsequent visits keep the existing
  // token unless they hit Regenerate.
  useEffect(() => {
    if (stage !== 'flow' || stepIdx !== 1 || hasGeneratedRef.current) {
      return
    }
    void generatePairing(false)
  }, [stage, stepIdx, generatePairing])

  const enterFlow = (): void => {
    setStepIdx(0)
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
          {stage === 'intro' ? (
            <HeroIntro onStart={enterFlow} />
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
              pairEndpoint={pairEndpoint}
              pairingUrl={pairingUrl}
              pairLoading={pairLoading}
              onRegeneratePairing={() => void generatePairing(true)}
              onBack={handleBack}
              onContinue={handleContinue}
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
