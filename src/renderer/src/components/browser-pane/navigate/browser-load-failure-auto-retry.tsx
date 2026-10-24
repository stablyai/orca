import { useEffect, useEffectEvent, useState, useSyncExternalStore } from 'react'
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
  whileWindowHidden?: boolean
  /** An attempt is in flight; the next one waits for it to settle instead of aborting it. */
  loading: boolean
}

/** Re-attempts the failed load; a pane whose attempt settles later returns a promise for it. */
export type BrowserLoadFailureRetry = () => void | Promise<void>

// Why faster than Chrome's 1s/5s/30s: a dev server comes up in seconds and a refused attempt is cheap.
const RETRY_DELAYS_MS = [1000, 1000, 2000, 3000, 5000]
const MAX_ATTEMPTS = 120

/** Runs `attempt` on the backoff schedule, never overlapping one still settling; returns its stop. */
function pollWithBackoff(attempt: () => Promise<void> | null, onExhausted: () => void): () => void {
  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const schedule = (): void => {
    if (stopped) {
      return
    }
    if (attempts >= MAX_ATTEMPTS) {
      onExhausted()
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
        void pending.then(schedule)
      },
      RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length - 1)]
    )
  }
  schedule()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

function subscribeToNetworkChanges(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

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
}): boolean {
  const [exhaustedKey, setExhaustedKey] = useState<string | null>(null)
  const enabled = Boolean(autoRetry?.active) && recovery !== null && exhaustedKey !== failureKey
  const whileWindowHidden = autoRetry?.whileWindowHidden ?? false
  const loading = autoRetry?.loading ?? false
  const online = useSyncExternalStore(subscribeToNetworkChanges, () => navigator.onLine)
  // Why: an offline failure polls once the network is back, since `online` can fire before DNS works.
  const polling = enabled && (recovery !== 'online' || online)
  const giveUp = useEffectEvent(() => setExhaustedKey(failureKey))
  const attempt = useEffectEvent((): Promise<void> | null => {
    if (loading || (!whileWindowHidden && !isWindowVisible())) {
      return null
    }
    return Promise.resolve(retry()).catch(() => {})
  })

  useEffect(() => {
    if (!polling) {
      return
    }
    // Why per run: coming back to a hidden tab starts again from the short delays.
    return pollWithBackoff(attempt, giveUp)
  }, [polling, failureKey])

  return enabled
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
  const waiting = useBrowserLoadFailureAutoRetry({
    failureKey,
    recovery: failure.recovery,
    autoRetry,
    retry
  })
  if (!waiting) {
    return null
  }
  return (
    <p className="mt-4 text-xs text-muted-foreground">
      {translateLoadFailurePiece(
        failure.recovery === 'online'
          ? 'waitingForNetwork'
          : failure.kind === 'route-down'
            ? 'waitingForHost'
            : failure.kind === 'not-running'
              ? 'waitingForServer'
              : 'waiting'
      )}
    </p>
  )
}
