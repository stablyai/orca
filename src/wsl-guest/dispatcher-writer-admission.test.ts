import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PRODUCER_QUEUE_MAX_BYTES,
  DISPATCHER_CONTROL_QUEUE_MAX_FRAMES,
  DispatcherWriterAdmission,
  type DispatcherWriterEntry,
  type DispatcherWriterLane
} from './dispatcher-writer-admission'

function createEntry(
  lane: DispatcherWriterLane,
  id: number,
  estimatedBytes = 1
): DispatcherWriterEntry {
  return {
    lane,
    encode: () => Buffer.from(String(id)),
    estimatedBytes,
    onSettled: () => undefined,
    settled: false
  }
}

function admitOrThrow(admission: DispatcherWriterAdmission, entry: DispatcherWriterEntry): void {
  const result = admission.admit(entry, Number.MAX_SAFE_INTEGER)
  if (!result.accepted) {
    throw new Error(`entry rejected from ${entry.lane}`)
  }
}

function shiftOrThrow(
  admission: DispatcherWriterAdmission,
  lane: DispatcherWriterLane
): DispatcherWriterEntry {
  const entry = admission.shift(lane)
  if (!entry) {
    throw new Error(`missing queued entry from ${lane}`)
  }
  return entry
}

describe('DispatcherWriterAdmission', () => {
  it('drains a release-scale lane in FIFO order across compactions', () => {
    const entryCount = 30_000
    const admission = new DispatcherWriterAdmission(DEFAULT_PRODUCER_QUEUE_MAX_BYTES)
    const entries = Array.from({ length: entryCount }, (_, index) =>
      createEntry('ordinary', index, 64)
    )

    for (const entry of entries) {
      admitOrThrow(admission, entry)
    }
    expect(admission.queuedEntries).toBe(entryCount)
    expect(admission.retainedProducerBytes).toBe(entryCount * 64)
    expect(admission.peek('ordinary')).toBe(entries[0])

    for (let index = 0; index < entries.length; index++) {
      const shifted = shiftOrThrow(admission, 'ordinary')
      if (shifted !== entries[index]) {
        throw new Error(`FIFO mismatch at ${index}`)
      }
      admission.release(shifted)
      if (index === 0 || index === Math.floor(entryCount / 2)) {
        expect(admission.peek('ordinary')).toBe(entries[index + 1])
      }
    }

    expect(admission.shift('ordinary')).toBeUndefined()
    expect(admission.queuedEntries).toBe(0)
    expect(admission.retainedProducerBytes).toBe(0)
  })

  it('keeps accounting retained until shifted entries are released', () => {
    const producerAdmission = new DispatcherWriterAdmission(4)
    const producerEntries = Array.from({ length: 4 }, (_, index) => createEntry('ordinary', index))
    for (const entry of producerEntries) {
      admitOrThrow(producerAdmission, entry)
      expect(shiftOrThrow(producerAdmission, 'ordinary')).toBe(entry)
    }
    expect(producerAdmission.queuedEntries).toBe(0)
    expect(producerAdmission.retainedProducerBytes).toBe(4)
    expect(producerAdmission.canAdmitProducer(1, 1)).toBe(false)
    producerAdmission.release(producerEntries[0])
    expect(producerAdmission.canAdmitProducer(1, 1)).toBe(true)
    for (const entry of producerEntries.slice(1)) {
      producerAdmission.release(entry)
    }

    const controlAdmission = new DispatcherWriterAdmission(1)
    const controlEntries = Array.from({ length: DISPATCHER_CONTROL_QUEUE_MAX_FRAMES }, (_, index) =>
      createEntry('control', index)
    )
    for (const entry of controlEntries) {
      admitOrThrow(controlAdmission, entry)
      expect(shiftOrThrow(controlAdmission, 'control')).toBe(entry)
    }
    expect(controlAdmission.queuedEntries).toBe(0)
    expect(controlAdmission.canAdmitControl(1)).toBe(false)
    controlAdmission.release(controlEntries[0])
    expect(controlAdmission.canAdmitControl(1)).toBe(true)
    for (const entry of controlEntries.slice(1)) {
      controlAdmission.release(entry)
    }
  })

  it('replaces only the live liveness tail after a consumed prefix', () => {
    const admission = new DispatcherWriterAdmission(1)
    const first = createEntry('liveness', 1)
    const queued = createEntry('liveness', 2)
    const replacement = createEntry('liveness', 3)

    admitOrThrow(admission, first)
    admitOrThrow(admission, queued)
    expect(shiftOrThrow(admission, 'liveness')).toBe(first)
    expect(admission.admit(replacement, Number.MAX_SAFE_INTEGER)).toEqual({
      accepted: true,
      replaced: queued
    })
    expect(shiftOrThrow(admission, 'liveness')).toBe(replacement)
    expect(admission.queuedEntries).toBe(0)
    expect(admission.admit(createEntry('liveness', 4), Number.MAX_SAFE_INTEGER)).toEqual({
      accepted: false
    })

    admission.release(first)
    admission.release(replacement)
    const afterRelease = createEntry('liveness', 5)
    admitOrThrow(admission, afterRelease)
    expect(shiftOrThrow(admission, 'liveness')).toBe(afterRelease)
    admission.release(afterRelease)
  })

  it('takes only the live suffix after deep partial drains and refills', () => {
    const admission = new DispatcherWriterAdmission(10_000)
    const initial = Array.from({ length: 4_096 }, (_, index) => createEntry('ordinary', index))
    for (const entry of initial) {
      admitOrThrow(admission, entry)
    }
    for (let index = 0; index < 3_000; index++) {
      const shifted = shiftOrThrow(admission, 'ordinary')
      expect(shifted).toBe(initial[index])
      admission.release(shifted)
    }
    const refill = Array.from({ length: 2_048 }, (_, index) =>
      createEntry('ordinary', initial.length + index)
    )
    for (const entry of refill) {
      admitOrThrow(admission, entry)
    }

    const expected = [...initial.slice(3_000), ...refill]
    const queued = admission.takeQueued()
    expect(queued).toEqual(expected)
    expect(admission.queuedEntries).toBe(0)
    expect(admission.retainedProducerBytes).toBe(expected.length)
    for (const entry of queued) {
      admission.release(entry)
    }
    expect(admission.retainedProducerBytes).toBe(0)
  })

  it('preserves close-time lane and per-lane FIFO order', () => {
    const admission = new DispatcherWriterAdmission(1_024)
    const fixedBulk = createEntry('fixed-bulk', 1)
    const liveness = createEntry('liveness', 2)
    const control = createEntry('control', 3)
    const legacy = createEntry('legacy-response', 4)
    const interactive = createEntry('interactive', 5)
    const ordinaryOne = createEntry('ordinary', 6)
    const ordinaryTwo = createEntry('ordinary', 7)
    const bulk = createEntry('bulk', 8)
    for (const entry of [
      fixedBulk,
      liveness,
      control,
      legacy,
      interactive,
      ordinaryOne,
      ordinaryTwo,
      bulk
    ]) {
      admitOrThrow(admission, entry)
    }

    const queued = admission.takeQueued()
    expect(queued).toEqual([
      liveness,
      control,
      legacy,
      interactive,
      ordinaryOne,
      ordinaryTwo,
      fixedBulk,
      bulk
    ])
    for (const entry of queued) {
      admission.release(entry)
    }
    expect(admission.queuedEntries).toBe(0)
    expect(admission.retainedProducerBytes).toBe(0)
    expect(admission.canAdmitControl(1)).toBe(true)
  })
})
