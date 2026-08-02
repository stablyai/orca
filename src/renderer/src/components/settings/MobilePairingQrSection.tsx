import { useCallback, useEffect, useRef } from 'react'
import { Check, CircleAlert, Copy, Maximize2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { translate } from '@/i18n/i18n'

type MobilePairingQrSectionProps = {
  qrDataUrl: string | null
  qrError: boolean
  pairingUrl: string | null
  endpoint: string | null
  qrEnlarged: boolean
  codeCopied: boolean
  onQrEnlargedChange: (open: boolean) => void
  onCodeCopiedChange: (copied: boolean) => void
  onClearCodeCopiedTimer: () => void
}

export function MobilePairingQrSection({
  qrDataUrl,
  qrError,
  pairingUrl,
  endpoint,
  qrEnlarged,
  codeCopied,
  onQrEnlargedChange,
  onCodeCopiedChange,
  onClearCodeCopiedTimer
}: MobilePairingQrSectionProps): React.JSX.Element | null {
  const pairingCodeButtonMountedRef = useRef(false)
  const pairingCodeButtonRef = useRef<HTMLButtonElement | null>(null)
  const hadPairingUrlRef = useRef(pairingUrl != null)
  const codeCopiedResetTimerRef = useRef<number | null>(null)

  // Why: the reset timeout is owned here, so clearing only the parent's timer would leave it running.
  const clearCodeCopiedResetTimer = useCallback(() => {
    if (codeCopiedResetTimerRef.current !== null) {
      window.clearTimeout(codeCopiedResetTimerRef.current)
      codeCopiedResetTimerRef.current = null
    }
    onClearCodeCopiedTimer()
  }, [onClearCodeCopiedTimer])

  const setPairingCodeButtonRef = useCallback(
    (node: HTMLButtonElement | null) => {
      pairingCodeButtonMountedRef.current = node !== null
      pairingCodeButtonRef.current = node
      if (node === null) {
        clearCodeCopiedResetTimer()
      }
    },
    [clearCodeCopiedResetTimer]
  )

  useEffect(() => {
    const becameReady = !hadPairingUrlRef.current && pairingUrl != null
    hadPairingUrlRef.current = pairingUrl != null
    if (becameReady && document.activeElement === document.body) {
      pairingCodeButtonRef.current?.focus()
    }
  }, [pairingUrl])

  async function copyPairingCode() {
    if (!pairingUrl) {
      return
    }
    try {
      await window.api.ui.writeClipboardText(pairingUrl)
      if (!pairingCodeButtonMountedRef.current) {
        return
      }
      clearCodeCopiedResetTimer()
      onCodeCopiedChange(true)
      codeCopiedResetTimerRef.current = window.setTimeout(() => {
        codeCopiedResetTimerRef.current = null
        onCodeCopiedChange(false)
      }, 2000)
    } catch {
      toast.error(
        translate('auto.components.settings.MobilePane.711231348f', 'Failed to copy pairing code')
      )
    }
  }

  if (!qrDataUrl && !pairingUrl) {
    return null
  }

  return (
    <>
      <div className="flex flex-col items-center gap-3 rounded-lg border border-border/60 py-6">
        {qrDataUrl ? (
          <button
            type="button"
            onClick={() => onQrEnlargedChange(true)}
            className="group relative cursor-pointer rounded-lg border border-border/60 bg-white p-3"
          >
            <img
              src={qrDataUrl}
              alt={translate(
                'auto.components.settings.MobilePane.6436e56546',
                'QR Code for mobile pairing'
              )}
              className="size-48"
            />
            <Maximize2 className="absolute top-1.5 right-1.5 size-3 text-black/30 can-hover:opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        ) : null}
        {endpoint && <span className="text-muted-foreground font-mono text-xs">{endpoint}</span>}
        {qrError ? (
          <p className="flex max-w-sm items-start gap-1.5 text-xs text-destructive" role="alert">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              {translate(
                'auto.components.settings.MobilePane.pairingQrError',
                'This pairing code couldn’t be rendered as a QR code. Copy it into Orca Mobile instead.'
              )}
            </span>
          </p>
        ) : (
          <p className="text-muted-foreground max-w-xs text-center text-xs">
            {translate(
              'auto.components.settings.MobilePane.310924ad2c',
              'Scan this code with the Orca mobile app. Each code creates a unique device token.'
            )}
          </p>
        )}
        {pairingUrl && (
          <div className="flex w-full max-w-lg flex-col gap-1.5 px-4">
            <div className="text-muted-foreground text-center text-xs">
              {translate(
                'auto.components.settings.MobilePane.e778ecb209',
                'Or paste this code in the mobile app:'
              )}
            </div>
            <Button
              ref={setPairingCodeButtonRef}
              variant="outline"
              size="sm"
              onClick={() => void copyPairingCode()}
              aria-label={translate(
                'auto.components.settings.MobilePane.copyPairingCode',
                'Copy pairing code'
              )}
              className="font-mono text-[11px] leading-tight whitespace-normal break-all h-auto py-2 px-3"
            >
              <span className="flex-1 text-left">{pairingUrl}</span>
              {codeCopied ? (
                <Check className="ml-2 size-3.5 shrink-0 text-emerald-500" />
              ) : (
                <Copy className="ml-2 size-3.5 shrink-0" />
              )}
            </Button>
          </div>
        )}
      </div>

      {qrDataUrl ? (
        <Dialog open={qrEnlarged} onOpenChange={onQrEnlargedChange}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>
                {translate(
                  'auto.components.settings.MobilePane.dd3cd78d04',
                  'Scan with Orca Mobile'
                )}
              </DialogTitle>
            </DialogHeader>
            <div className="flex flex-col items-center gap-3">
              <div className="rounded-lg bg-white p-4">
                <img
                  src={qrDataUrl}
                  alt={translate(
                    'auto.components.settings.MobilePane.6436e56546',
                    'QR Code for mobile pairing'
                  )}
                  className="size-72"
                />
              </div>
              {endpoint && (
                <span className="text-muted-foreground font-mono text-xs">{endpoint}</span>
              )}
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  )
}
