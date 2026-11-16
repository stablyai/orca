import { Check, Copy, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useTranslate } from '@/i18n/use-translate'
import { LoadingSpinner } from '../LoadingSpinner'
import { Button } from '../ui/button'
import { useRuntimePairingUrlCopy } from '../settings/runtime-environments/pairing/use-runtime-pairing-url-copy'

type AccessLinks = {
  pairingUrl: string | null
  webClientUrl: string | null
  qrDataUrl: string | null
  error: string | null
}

/** Mints offers through the same pairing IPC as Settings → Share this computer, pinned to the tailnet IP. */
export function ZotzAccessLink({ address }: { address: string }): React.JSX.Element {
  const t = useTranslate()
  const mountedRef = useMountedRef()
  const { copiedTarget, copyGeneratedUrl, setContainerNode } = useRuntimePairingUrlCopy(mountedRef)
  const [links, setLinks] = useState<AccessLinks | null>(null)
  const [generating, setGenerating] = useState(false)

  const generate = useCallback(async (): Promise<void> => {
    setGenerating(true)
    try {
      const [runtime, mobile] = await Promise.all([
        window.api.mobile.getRuntimePairingUrl({ address, rotate: true, reach: 'network' }),
        window.api.mobile.getPairingQR({ address, connectionMode: 'local-only', rotate: true })
      ])
      if (mountedRef.current) {
        setLinks({
          pairingUrl: runtime.available ? runtime.pairingUrl : null,
          webClientUrl: runtime.available ? runtime.webClientUrl : null,
          qrDataUrl: mobile.available ? mobile.qrDataUrl : null,
          error: runtime.available ? null : (runtime.guidance ?? null)
        })
      }
    } catch (error) {
      if (mountedRef.current) {
        const message = error instanceof Error ? error.message : String(error)
        setLinks({ pairingUrl: null, webClientUrl: null, qrDataUrl: null, error: message })
      }
    } finally {
      if (mountedRef.current) {
        setGenerating(false)
      }
    }
  }, [address, mountedRef])

  useEffect(() => {
    void generate()
  }, [generate])

  if (!links) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoadingSpinner className="size-4" />
        {t('zotz.nodeSetup.link.generating', 'Generating the access link…')}
      </div>
    )
  }

  const { pairingUrl, webClientUrl } = links
  return (
    <div ref={setContainerNode} className="space-y-4">
      {pairingUrl ? (
        <LinkRow
          label={t('zotz.nodeSetup.link.desktop', 'Link for another computer (Zotz or Orca)')}
          value={pairingUrl}
          copied={copiedTarget === 'pairing'}
          onCopy={() => void copyGeneratedUrl('pairing', pairingUrl)}
        />
      ) : null}
      {webClientUrl ? (
        <LinkRow
          label={t('zotz.nodeSetup.link.web', 'Link for a browser')}
          value={webClientUrl}
          copied={copiedTarget === 'web'}
          onCopy={() => void copyGeneratedUrl('web', webClientUrl)}
        />
      ) : null}
      {links.qrDataUrl ? (
        <div className="flex items-center gap-4">
          <img
            src={links.qrDataUrl}
            alt={t('zotz.nodeSetup.link.qrAlt', 'Pairing QR code')}
            className="size-36 rounded-md border border-border bg-white p-2"
          />
          <p className="text-xs text-muted-foreground">
            {t(
              'zotz.nodeSetup.link.qr',
              'Scan it with the Orca mobile app while your phone is on Tailscale.'
            )}
          </p>
        </div>
      ) : null}
      {links.error ? <p className="text-sm text-destructive">{links.error}</p> : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={generating}
        onClick={() => void generate()}
      >
        <RefreshCw className={generating ? 'animate-spin motion-reduce:animate-none' : undefined} />
        {t('zotz.nodeSetup.link.regenerate', 'New link')}
      </Button>
    </div>
  )
}

function LinkRow({
  label,
  value,
  copied,
  onCopy
}: {
  label: string
  value: string
  copied: boolean
  onCopy: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-xs">
          {value}
        </code>
        <Button type="button" variant="outline" size="sm" onClick={onCopy}>
          {copied ? <Check /> : <Copy />}
          {t('zotz.nodeSetup.link.copy', 'Copy')}
        </Button>
      </div>
    </div>
  )
}
