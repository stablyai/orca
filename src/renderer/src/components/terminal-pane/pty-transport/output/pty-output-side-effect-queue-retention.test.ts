import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPtyOutputSideEffectQueue,
  MAX_PENDING_PTY_SIDE_EFFECTS,
  type PendingPtySideEffect,
  type PtyOutputSideEffectQueue
} from './pty-output-side-effect-queue'

function enqueueEffects(
  queue: PtyOutputSideEffectQueue,
  count: number
): WeakRef<PendingPtySideEffect>[] {
  const references: WeakRef<PendingPtySideEffect>[] = []
  for (let index = 0; index < count; index += 1) {
    const effect: PendingPtySideEffect = {
      payloads: [],
      titles: [`title-${index}`],
      titleScanEffect: 'none',
      containsBell: false,
      suppressAttentionEvents: false
    }
    references.push(new WeakRef(effect))
    queue.enqueue(effect)
  }
  return references
}

async function collectEffects(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  // WeakRefs keep new targets alive until the next event-loop turn.
  await new Promise<void>((resolve) => setImmediate(resolve))
  globalThis.gc()
  globalThis.gc()
}

describe('PTY side-effect queue retention', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('releases applied effects while preserving every pending effect and its delivery order', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const delivered: string[] = []
    const queue = createPtyOutputSideEffectQueue({
      countWorkingTitles: (titles) => titles.length,
      apply: (effect) => delivered.push(...effect.titles)
    })
    try {
      const references = enqueueEffects(queue, 100)
      queue.scheduleDrain()
      await vi.runOnlyPendingTimersAsync()
      queue.pause()
      expect(delivered).toEqual(Array.from({ length: 64 }, (_, index) => `title-${index}`))
      expect(queue.pendingWorkingTitleCount()).toBe(36)

      await collectEffects()
      expect(references.slice(0, 64).every((reference) => reference.deref() === undefined)).toBe(
        true
      )
      expect(references.slice(64).every((reference) => reference.deref() !== undefined)).toBe(true)

      queue.flush()
      expect(delivered).toEqual(Array.from({ length: 100 }, (_, index) => `title-${index}`))
      expect(queue.isDrained()).toBe(true)
      expect(queue.pendingWorkingTitleCount()).toBe(0)
    } finally {
      queue.clear()
      queue.disposeGauge()
    }
  })

  it('releases an evicted effect before the compaction threshold', async () => {
    const delivered: string[] = []
    const queue = createPtyOutputSideEffectQueue({
      countWorkingTitles: (titles) => titles.length,
      apply: (effect) => delivered.push(...effect.titles)
    })
    try {
      const references = enqueueEffects(queue, MAX_PENDING_PTY_SIDE_EFFECTS + 1)
      await collectEffects()
      expect(references[0].deref()).toBeUndefined()
      expect(references.slice(1).every((reference) => reference.deref() !== undefined)).toBe(true)
      expect(queue.pendingWorkingTitleCount()).toBe(MAX_PENDING_PTY_SIDE_EFFECTS)

      queue.flush()
      expect(delivered).toEqual(
        Array.from({ length: MAX_PENDING_PTY_SIDE_EFFECTS }, (_, index) => `title-${index + 1}`)
      )
    } finally {
      queue.clear()
      queue.disposeGauge()
    }
  })

  it('releases every pending effect immediately when clear is called during apply', async () => {
    let references: WeakRef<PendingPtySideEffect>[] = []
    let collected = 0
    const queue = createPtyOutputSideEffectQueue({
      countWorkingTitles: (titles) => titles.length,
      apply: () => {
        queue.clear()
        if (typeof globalThis.gc !== 'function') {
          throw new Error('The test runner must enable --expose-gc')
        }
        globalThis.gc()
        globalThis.gc()
        collected = references
          .slice(1)
          .filter((reference) => reference.deref() === undefined).length
      }
    })
    try {
      references = enqueueEffects(queue, 100)
      await new Promise<void>((resolve) => setImmediate(resolve))
      queue.flush()
      expect(collected).toBe(99)
      expect(queue.isDrained()).toBe(true)
    } finally {
      queue.clear()
      queue.disposeGauge()
    }
  })
})
