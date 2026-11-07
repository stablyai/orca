import { expect, it } from 'vitest'
import { createBulkWriteHarness, nextBulkWriteTurn } from './dispatcher-bulk-write-test-harness'

it('admits each bulk frame once when retiring PTY writes releases capacity during admission', async () => {
  const calibration = createBulkWriteHarness()
  let capacity: number
  try {
    capacity = calibration.fillProducerQueue('live')
  } finally {
    calibration.dispose()
  }

  const failures: { retired: number; sequences: (number | undefined)[] }[] = []
  let admissionRetryWakeCount = 0
  const midpoint = Math.floor(capacity / 2)
  for (let retired = midpoint - 100; retired <= midpoint + 20; retired++) {
    const harness = createBulkWriteHarness()
    let ptyAdmitted = true
    harness.dispatcher.registerPtyDataPublicationAdmission(
      (_client, params) => ptyAdmitted || params.id !== 'dying'
    )
    try {
      harness.fillProducerQueue('live', capacity - retired)
      harness.fillProducerQueue('dying', retired)
      const completion = harness.dispatcher.notifyBulk('git.responseChunk', {
        streamId: 1,
        seq: 0,
        data: 'g'.repeat(40 * 1024)
      })
      await nextBulkWriteTurn()
      expect(harness.dispatcher.capacityRetryCount).toBe(1)
      ptyAdmitted = false
      await harness.drain()
      await completion
      admissionRetryWakeCount += harness.dispatcher.admissionRetryWakeCount
      const sequences = harness.frames
        .filter((frame) => frame.method === 'git.responseChunk')
        .map((frame) => frame.seq)
      if (sequences.length !== 1 || sequences[0] !== 0) {
        failures.push({ retired, sequences })
      }
    } finally {
      harness.dispose()
    }
  }
  expect(failures).toEqual([])
  expect(admissionRetryWakeCount).toBeGreaterThan(0)
})
