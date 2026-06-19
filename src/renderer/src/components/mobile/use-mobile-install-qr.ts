import { useEffect, useState } from 'react'
import QRCodeBrowser from 'qrcode/lib/browser'
import type { Platform } from './MobileHero'
import { PLATFORM_COPY } from './mobile-platform-copy'
import type { MobilePageStage } from './mobile-page-stage'

async function renderQrDataUrl(text: string): Promise<string> {
  return QRCodeBrowser.toDataURL(text, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 232
  })
}

export function useMobileInstallQr(
  stage: MobilePageStage | null,
  platform: Platform
): string | null {
  const [installQrUrl, setInstallQrUrl] = useState<string | null>(null)

  // Why: render install QRs lazily after flow entry, and clear stale platform
  // images synchronously while the replacement QR is rendering.
  useEffect(() => {
    if (stage !== 'flow') {
      return
    }
    setInstallQrUrl(null)
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

  return installQrUrl
}
