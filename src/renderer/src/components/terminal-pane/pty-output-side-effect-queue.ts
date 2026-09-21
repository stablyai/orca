import {
  registerPtySideEffectPendingGauge,
  type PtySideEffectGauge
} from './pty-side-effect-pending-census'
import type { ProcessedAgentStatusChunk } from '../../../../shared/agent-status-osc'

const MAX_PTY_SIDE_EFFECTS_PER_DRAIN = 64
export const MAX_PENDING_PTY_SIDE_EFFECTS = 512
export const MAX_EVICTED_AGENT_STATUS_PAYLOAD_CARRY = 16

export type PendingPtySideEffect = {
  payloads: ProcessedAgentStatusChunk['payloads']
  titles: string[]
  titleScanEffect: 'none' | 'stale-probe' | 'ignored-cursor-native'
  containsBell: boolean
  suppressAttentionEvents: boolean
}

type PtyOutputSideEffectQueueOptions = {
  countWorkingTitles: (titles: string[]) => number
  apply: (effect: PendingPtySideEffect) => void
}

export type PtyOutputSideEffectQueue = {
  enqueue: (effect: PendingPtySideEffect) => void
  scheduleDrain: () => void
  flush: () => void
  pause: () => void
  clear: () => void
  isDrained: () => boolean
  pendingWorkingTitleCount: () => number
  disposeGauge: () => void
}

export function createPtyOutputSideEffectQueue({
  countWorkingTitles,
  apply
}: PtyOutputSideEffectQueueOptions): PtyOutputSideEffectQueue {
  let drainTimer: ReturnType<typeof setTimeout> | null = null
  let pendingEffects: PendingPtySideEffect[] = []
  let pendingIndex = 0
  let pendingWorkingTitles = 0
  const gauge: PtySideEffectGauge = {
    pending: () => pendingEffects.length - pendingIndex,
    retained: () => pendingEffects.length
  }
  const disposeGauge = registerPtySideEffectPendingGauge(gauge)

  function compact(force = false): void {
    if (pendingIndex === 0) {
      return
    }
    if (pendingIndex >= pendingEffects.length) {
      pendingEffects = []
      pendingIndex = 0
      return
    }
    if (force || pendingIndex >= MAX_PTY_SIDE_EFFECTS_PER_DRAIN * 4) {
      pendingEffects = pendingEffects.slice(pendingIndex)
      pendingIndex = 0
    }
  }

  function evictOldestIfFull(): void {
    while (pendingEffects.length - pendingIndex >= MAX_PENDING_PTY_SIDE_EFFECTS) {
      const evicted = pendingEffects[pendingIndex]
      if (!evicted) {
        return
      }
      pendingIndex += 1
      pendingWorkingTitles = Math.max(0, pendingWorkingTitles - countWorkingTitles(evicted.titles))
      const survivor = pendingEffects[pendingIndex]
      if (survivor) {
        if (evicted.containsBell) {
          survivor.containsBell = true
        }
        if (evicted.payloads.length > 0) {
          const merged = evicted.payloads.concat(survivor.payloads)
          survivor.payloads =
            merged.length > MAX_EVICTED_AGENT_STATUS_PAYLOAD_CARRY
              ? merged.slice(-MAX_EVICTED_AGENT_STATUS_PAYLOAD_CARRY)
              : merged
        }
      }
      compact()
    }
  }

  function enqueue(effect: PendingPtySideEffect): void {
    const prior = pendingEffects.at(-1)
    if (
      prior &&
      prior.titles.length === 0 &&
      prior.payloads.length === 0 &&
      !prior.containsBell &&
      prior.suppressAttentionEvents === effect.suppressAttentionEvents &&
      effect.titles.length === 0 &&
      effect.payloads.length === 0 &&
      !effect.containsBell
    ) {
      prior.titleScanEffect = effect.titleScanEffect
      return
    }
    evictOldestIfFull()
    pendingEffects.push(effect)
    pendingWorkingTitles += countWorkingTitles(effect.titles)
  }

  function clearDrainTimer(): void {
    if (drainTimer !== null) {
      clearTimeout(drainTimer)
      drainTimer = null
    }
  }

  function scheduleDrain(): void {
    if (drainTimer !== null) {
      return
    }
    drainTimer = setTimeout(drain, 0)
  }

  function drain(options: { flushAll?: boolean } = {}): void {
    drainTimer = null
    const limit = options.flushAll ? Number.POSITIVE_INFINITY : MAX_PTY_SIDE_EFFECTS_PER_DRAIN
    let processed = 0
    while (pendingIndex < pendingEffects.length && processed < limit) {
      const next = pendingEffects[pendingIndex]
      if (!next) {
        break
      }
      pendingIndex += 1
      processed += 1
      pendingWorkingTitles = Math.max(0, pendingWorkingTitles - countWorkingTitles(next.titles))
      apply(next)
    }
    compact(options.flushAll === true)
    if (pendingIndex < pendingEffects.length) {
      scheduleDrain()
    }
  }

  return {
    enqueue,
    scheduleDrain,
    flush: () => {
      clearDrainTimer()
      drain({ flushAll: true })
    },
    pause: clearDrainTimer,
    clear: () => {
      clearDrainTimer()
      pendingEffects.length = 0
      pendingIndex = 0
      pendingWorkingTitles = 0
    },
    isDrained: () => pendingIndex >= pendingEffects.length,
    pendingWorkingTitleCount: () => pendingWorkingTitles,
    disposeGauge
  }
}
