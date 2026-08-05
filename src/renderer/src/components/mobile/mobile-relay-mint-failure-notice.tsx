import { useEffect, useState } from 'react'
import { CircleAlert, Loader2 } from 'lucide-react'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'
import type { MobileRelayMintFailure } from '../../../../shared/mobile-relay-mint-failure'
import { cn } from '@/lib/utils'

export function MobileRelayMintFailureNotice({
  failure,
  onUseLan,
  onRetry,
  onCopyDiagnostics,
  className,
  compact = false,
  busy = false
}: {
  failure: MobileRelayMintFailure
  onUseLan: () => void
  onRetry: () => void
  onCopyDiagnostics: () => void
  className?: string
  compact?: boolean
  busy?: boolean
}): React.JSX.Element {
  const providerMissing = failure.stage === 'provider_missing'
  const [showBusyFeedback, setShowBusyFeedback] = useState(false)
  useEffect(() => {
    if (!busy) {
      setShowBusyFeedback(false)
      return
    }
    const timer = window.setTimeout(() => setShowBusyFeedback(true), 200)
    return () => window.clearTimeout(timer)
  }, [busy])
  const visibleBusy = busy && showBusyFeedback
  const title = visibleBusy
    ? translate(
        'auto.components.mobile.MobileRelayMintFailureNotice.retryingTitle',
        'Retrying Orca Relay…'
      )
    : providerMissing
      ? translate(
          'auto.components.mobile.MobileRelayMintFailureNotice.unavailableTitle',
          'Orca Relay isn’t available on this desktop.'
        )
      : translate(
          'auto.components.mobile.MobileRelayMintFailureNotice.title',
          'Couldn’t create a Relay pairing code.'
        )
  const body = visibleBusy
    ? translate(
        'auto.components.mobile.MobileRelayMintFailureNotice.retryingBody',
        'Creating a new pairing code. This can take a moment over a remote connection.'
      )
    : providerMissing
      ? translate(
          'auto.components.mobile.MobileRelayMintFailureNotice.unavailableBody',
          'Use LAN to pair over Tailscale or the same Wi‑Fi.'
        )
      : translate(
          'auto.components.mobile.MobileRelayMintFailureNotice.body',
          'Retry, or use LAN to pair over Tailscale or the same Wi‑Fi.'
        )

  return (
    <div
      className={cn(
        'flex w-full min-w-0 items-start gap-2 rounded-lg border p-3 text-xs',
        visibleBusy
          ? 'border-border bg-muted/40 text-foreground'
          : 'border-destructive/30 bg-destructive/10 text-destructive',
        className
      )}
      data-testid="relay-mint-failure-notice"
    >
      {visibleBusy ? (
        <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" aria-hidden />
      ) : (
        <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      )}
      <div className="min-w-0 flex-1 space-y-2">
        <p
          className="min-w-0"
          role={visibleBusy ? 'status' : 'alert'}
          aria-live={visibleBusy ? 'polite' : 'assertive'}
        >
          <span className="font-medium">{title}</span> {body}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size={compact ? 'xs' : 'sm'} onClick={onUseLan}>
            {translate('auto.components.mobile.MobileRelayMintFailureNotice.useLan', 'Use LAN')}
          </Button>
          {!providerMissing ? (
            <Button
              type="button"
              size={compact ? 'xs' : 'sm'}
              variant="outline"
              onClick={onRetry}
              disabled={busy}
              className="w-28"
            >
              {visibleBusy ? <Loader2 className="animate-spin" /> : null}
              {visibleBusy
                ? translate(
                    'auto.components.mobile.MobileRelayMintFailureNotice.retrying',
                    'Retrying…'
                  )
                : translate(
                    'auto.components.mobile.MobileRelayMintFailureNotice.retry',
                    'Retry Relay'
                  )}
            </Button>
          ) : null}
          <Button
            type="button"
            size={compact ? 'xs' : 'sm'}
            variant="ghost"
            onClick={onCopyDiagnostics}
          >
            {translate(
              'auto.components.mobile.MobileRelayMintFailureNotice.copyDiagnostics',
              'Copy diagnostics'
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
