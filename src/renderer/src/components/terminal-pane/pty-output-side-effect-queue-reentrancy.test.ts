import { describe, expect, it } from 'vitest'
import {
  createPtyOutputSideEffectQueue,
  type PendingPtySideEffect,
  type PtyOutputSideEffectQueue
} from './pty-output-side-effect-queue'

function emptyEffect(titleScanEffect: PendingPtySideEffect['titleScanEffect'] = 'none') {
  return {
    payloads: [],
    titles: [],
    titleScanEffect,
    containsBell: false,
    suppressAttentionEvents: false
  }
}

function titledEffect(title: string): PendingPtySideEffect {
  return { ...emptyEffect(), titles: [title] }
}

function withQueue(
  run: (queue: PtyOutputSideEffectQueue) => void,
  apply: (effect: PendingPtySideEffect) => void
): void {
  const queue = createPtyOutputSideEffectQueue({
    countWorkingTitles: (titles) => titles.length,
    apply
  })
  try {
    run(queue)
  } finally {
    queue.clear()
    queue.disposeGauge()
  }
}

describe('PTY side-effect queue reentrant delivery', () => {
  it('keeps empty-tail coalescing observable during the apply callback', () => {
    let queue: PtyOutputSideEffectQueue
    const observed: string[] = []
    withQueue(
      (created) => {
        queue = created
        queue.enqueue(emptyEffect())
        queue.flush()
        expect(observed).toEqual(['none', 'stale-probe'])
        expect(queue.isDrained()).toBe(true)
      },
      (effect) => {
        observed.push(effect.titleScanEffect)
        queue.enqueue(emptyEffect('stale-probe'))
        observed.push(effect.titleScanEffect)
      }
    )
  })

  it('delivers the same effect requeued after clear without releasing its new slot', () => {
    let queue: PtyOutputSideEffectQueue
    const delivered: string[] = []
    withQueue(
      (created) => {
        queue = created
        queue.enqueue(titledEffect('same'))
        queue.flush()
        expect(delivered).toEqual(['same', 'same'])
        expect(queue.isDrained()).toBe(true)
        expect(queue.pendingWorkingTitleCount()).toBe(0)
      },
      (effect) => {
        delivered.push(...effect.titles)
        if (delivered.length === 1) {
          queue.clear()
          queue.enqueue(effect)
        }
      }
    )
  })

  it('preserves nested flush order and effects enqueued after the inner compaction', () => {
    let queue: PtyOutputSideEffectQueue
    const delivered: string[] = []
    withQueue(
      (created) => {
        queue = created
        queue.enqueue(titledEffect('first'))
        queue.enqueue(titledEffect('second'))
        queue.flush()
        expect(delivered).toEqual(['first', 'second', 'third'])
        expect(queue.isDrained()).toBe(true)
        expect(queue.pendingWorkingTitleCount()).toBe(0)
      },
      (effect) => {
        delivered.push(...effect.titles)
        if (effect.titles[0] === 'first') {
          queue.flush()
          queue.enqueue(titledEffect('third'))
        }
      }
    )
  })

  it('preserves thrown apply errors and their existing empty-tail coalescing', () => {
    const failure = new Error('apply failed')
    let applied = 0
    withQueue(
      (queue) => {
        queue.enqueue(emptyEffect())
        expect(() => queue.flush()).toThrow(failure)
        queue.enqueue(emptyEffect('stale-probe'))
        queue.flush()
        expect(applied).toBe(1)
        expect(queue.isDrained()).toBe(true)
      },
      () => {
        applied += 1
        throw failure
      }
    )
  })
})
