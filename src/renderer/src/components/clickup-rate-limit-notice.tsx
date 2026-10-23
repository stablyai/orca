import { useEffect, useState } from 'react'
import { Clock } from 'lucide-react'
import type { ClickUpRateLimitState } from '../../../shared/clickup-types'
import { translate } from '@/i18n/i18n'

const IDLE_STATE: ClickUpRateLimitState = { pausedUntil: null, rateLimited: false }

// Shows the main process's shared ClickUp pause so a paced or rate-limited
// queue reads as "waiting", not as a hang.
export function ClickUpRateLimitNotice(): React.JSX.Element | null {
  const [state, setState] = useState<ClickUpRateLimitState>(IDLE_STATE)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const api = window.api.clickup
    // Why the guard: remote-runtime and web builds have no local ClickUp queue.
    if (!api?.onRateLimitStateChange) {
      return
    }
    let disposed = false
    void api
      .rateLimitState()
      .then((initial) => {
        if (!disposed) {
          setState(initial)
        }
      })
      .catch(() => undefined)
    const unsubscribe = api.onRateLimitStateChange(setState)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  const pausedUntil = state.pausedUntil
  useEffect(() => {
    if (!pausedUntil) {
      return
    }
    // Why a 1s tick only while paused: the countdown needs it, idle pages do not.
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [pausedUntil])

  if (!pausedUntil || pausedUntil <= now) {
    return null
  }
  const seconds = Math.max(1, Math.ceil((pausedUntil - now) / 1_000))
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground"
    >
      <Clock className="size-3.5 shrink-0" />
      {state.rateLimited
        ? translate(
            'auto.components.clickup.rateLimit.limited',
            'ClickUp rate limit reached, retrying in {{seconds}}s',
            { seconds }
          )
        : translate(
            'auto.components.clickup.rateLimit.paced',
            'Pacing ClickUp requests to stay under the rate limit, resuming in {{seconds}}s',
            { seconds }
          )}
    </div>
  )
}
