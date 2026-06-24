import type { ContextualTourId } from '../../../../shared/contextual-tours'
import { useAppStore } from '@/store'

type RequestContextualTourWhenReadyArgs = {
  id: ContextualTourId
  source: string
  wasFeaturePreviouslyInteracted?: boolean
  maxAttempts?: number
  retryDelayMs?: number
  waitForActiveTourToClear?: boolean
  shouldContinue?: () => boolean
  onAbandon?: (reason: 'blocked' | 'exhausted' | 'invalid') => void
  force?: boolean
}

export type { RequestContextualTourWhenReadyArgs }

export function requestContextualTourWhenReady(
  args: RequestContextualTourWhenReadyArgs
): () => void {
  const maxAttempts = args.maxAttempts ?? 20
  const retryDelayMs = args.retryDelayMs ?? 100
  let attempts = 0
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let cancelled = false
  let abandoned = false

  const abandon = (reason: 'blocked' | 'exhausted' | 'invalid'): void => {
    if (abandoned) {
      return
    }
    abandoned = true
    cancelled = true
    args.onAbandon?.(reason)
  }

  const attempt = (): void => {
    if (cancelled) {
      return
    }
    if (args.shouldContinue && !args.shouldContinue()) {
      abandon('invalid')
      return
    }
    attempts += 1

    const before = useAppStore.getState()
    if (before.activeContextualTourId && before.activeContextualTourId !== args.id) {
      if (args.waitForActiveTourToClear && attempts < maxAttempts) {
        timeoutId = setTimeout(attempt, retryDelayMs)
      } else {
        abandon('blocked')
      }
      return
    }

    before.requestContextualTour(args.id, args.source, args.wasFeaturePreviouslyInteracted, {
      force: args.force ?? true
    })

    const after = useAppStore.getState()
    if (after.activeContextualTourId === args.id) {
      return
    }
    if (attempts >= maxAttempts) {
      abandon('exhausted')
      return
    }
    timeoutId = setTimeout(attempt, retryDelayMs)
  }

  // Why: setup-guide actions often reveal lazy surfaces first; retrying keeps
  // explicit user-triggered education from depending on renderer mount timing.
  timeoutId = setTimeout(attempt, 0)

  return () => {
    cancelled = true
    if (timeoutId !== null) {
      clearTimeout(timeoutId)
    }
  }
}
