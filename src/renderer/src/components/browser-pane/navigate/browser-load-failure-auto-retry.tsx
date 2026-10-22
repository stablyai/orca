import { useEffect, useEffectEvent, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type {
  BrowserLoadFailureDescription,
  BrowserLoadFailureRecovery
} from '../../../../../shared/browser-load-failure'
import { isWindowVisible } from '@/lib/window-visibility-interval'
import { translateLoadFailurePiece } from './browser-notices'

/** When a pane lets its failure page re-attempt the load by itself. */
export type BrowserLoadFailureAutoRetry = {
  /** The page is on screen somewhere: this desktop, a phone, or a paired viewer. */
  active: boolean
  /** Keep going while this window is hidden, because someone else is looking at the page. */
  whileWindowHidden: boolean
  /** An attempt is in flight; the next one waits for it to settle instead of aborting it. */
  loading: boolean
}

/** Re-attempts the failed load; a pane whose attempt settles later returns a promise for it. */
export type BrowserLoadFailureRetry = () => void | Promise<void>

// Why faster than Chrome's 1s/5s/30s: a dev server usually comes up within seconds, and a
// refused attempt costs one local connect.
const RETRY_DELAYS_MS = [1000, 1000, 2000, 3000, 5000]
const MAX_ATTEMPTS = 120

function useBrowserLoadFailureAutoRetry({
  failureKey,
  recovery,
  autoRetry,
  retry
}: {
  /** Identifies the failure, so a fresh error object from each failed attempt keeps the backoff. */
  failureKey: string
  recovery: BrowserLoadFailureRecovery
  autoRetry: BrowserLoadFailureAutoRetry | undefined
  retry: BrowserLoadFailureRetry
}): { waiting: boolean; stop: () => void } {
  const [stoppedKey, setStoppedKey] = useState<string | null>(null)
  const enabled = Boolean(autoRetry?.active) && recovery !== null && stoppedKey !== failureKey
  const whileWindowHidden = autoRetry?.whileWindowHidden ?? false
  const loading = autoRetry?.loading ?? false
  const retryNow = useEffectEvent(retry)
  const attempt = useEffectEvent((): Promise<void> | null => {
    if (loading || (!whileWindowHidden && !isWindowVisible())) {
      return null
    }
    return Promise.resolve(retry()).catch(() => {})
  })

  useEffect(() => {
    if (!enabled) {
      return
    }
    if (recovery === 'online') {
      const onOnline = (): void => void retryNow()
      // Why: the network may have come back while this page was off screen and not listening.
      if (navigator.onLine) {
        onOnline()
      }
      window.addEventListener('online', onOnline)
      return () => window.removeEventListener('online', onOnline)
    }
    // Why per run: coming back to a hidden tab starts again from the short delays.
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false
    const schedule = (): void => {
      if (cancelled) {
        return
      }
      if (attempts >= MAX_ATTEMPTS) {
        setStoppedKey(failureKey)
        return
      }
      timer = setTimeout(
        () => {
          const pending = attempt()
          if (!pending) {
            schedule()
            return
          }
          attempts += 1
          // Why: a remote attempt can take a round trip before it reports loading; never overlap it.
          void pending.then(schedule)
        },
        RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length - 1)]
      )
    }
    schedule()
    return () => {
      cancelled = true
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [enabled, failureKey, recovery])

  return {
    waiting: enabled,
    stop: () => setStoppedKey(failureKey)
  }
}

/** Re-attempts a failed load through the pane's own Retry while mounted, and says that it is waiting. */
export function BrowserLoadFailureAutoRetryStatus({
  failureKey,
  failure,
  autoRetry,
  retry
}: {
  failureKey: string
  failure: BrowserLoadFailureDescription
  autoRetry: BrowserLoadFailureAutoRetry | undefined
  retry: BrowserLoadFailureRetry
}): React.JSX.Element | null {
  const { waiting, stop } = useBrowserLoadFailureAutoRetry({
    failureKey,
    recovery: failure.recovery,
    autoRetry,
    retry
  })
  if (!waiting) {
    return null
  }
  return (
    <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
      <Loader2 className="size-3 animate-spin" />
      {translateLoadFailurePiece(
        failure.recovery === 'online'
          ? 'waitingForNetwork'
          : failure.kind === 'route-down'
            ? 'waitingForHost'
            : 'waiting'
      )}{' '}
      <Button type="button" variant="link" size="xs" className="h-auto px-0" onClick={stop}>
        {translateLoadFailurePiece('stopWaiting')}
      </Button>
    </p>
  )
}
