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

  const attempt = (): void => {
    if (cancelled) {
      return
    }
    if (args.shouldContinue && !args.shouldContinue()) {
      cancelled = true
      return
    }
    attempts += 1

    const before = useAppStore.getState()
    if (before.activeContextualTourId && before.activeContextualTourId !== args.id) {
      if (args.waitForActiveTourToClear && attempts < maxAttempts) {
        timeoutId = setTimeout(attempt, retryDelayMs)
      }
      return
    }

    before.requestContextualTour(args.id, args.source, args.wasFeaturePreviouslyInteracted, {
      force: true
    })

    const after = useAppStore.getState()
    if (after.activeContextualTourId === args.id || attempts >= maxAttempts) {
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
