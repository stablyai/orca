import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { OrchestrationDb } from '../../../src/main/runtime/orchestration/db'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

// Pin the last pre-v41 implementation: this contract specifically exercises status-only readers.
const PRE_V41 = 'aac38d698ff75ac4c8658addab48ef5a83617619'

test('pre-v41 code opens, acknowledges and writes a v41 database, then current code reopens it', async () => {
  const checkout = await materializeReleaseCheckout(PRE_V41)
  const baseline = await importReleaseCheckoutModule(
    checkout,
    'src/main/runtime/orchestration/db.ts'
  )
  const OldDb = baseline.OrchestrationDb as typeof OrchestrationDb
  const directory = mkdtempSync(join(tmpdir(), 'orca-delivery-downgrade-'))
  const path = join(directory, 'orchestration.db')
  let db: OrchestrationDb | undefined
  try {
    db = new OldDb(path)
    expect(db.db.pragma('user_version', { simple: true })).toBe(40)
    const run = db.createRun({
      objective: 'downgrade round trip',
      coordinatorHandle: 'coord',
      coordinatorPaneKey: 'tab:11111111-1111-4111-8111-111111111111'
    })
    const params = { runId: run.id, consumerGeneration: run.consumer_generation }
    const insert = (subject: string) =>
      db!.insertMessage({
        runId: run.id,
        from: 'worker',
        to: `run:${run.id}`,
        subject
      })
    const oldMessage = insert('obsolete heartbeat')
    const oldBatch = db.getOrCreateRunDelivery(params)!
    db.close()

    db = new OrchestrationDb(path)
    db.markAsRead([oldMessage.id])
    const completion = insert('completion')
    const currentBatch = db.getOrCreateRunDelivery(params)!
    expect(currentBatch.messages.map((message) => message.id)).toEqual([completion.id])
    expect(currentBatch.delivery.id).not.toBe(oldBatch.delivery.id)
    db.close()

    db = new OldDb(path)
    expect(db.db.pragma('user_version', { simple: true })).toBe(41)
    // Old readers retain their original replay semantics, but can acknowledge either stored batch.
    db.acknowledgeRunDelivery({ ...params, deliveryId: oldBatch.delivery.id })
    expect(db.getOrCreateRunDelivery(params)?.delivery.id).toBe(currentBatch.delivery.id)
    db.acknowledgeRunDelivery({ ...params, deliveryId: currentBatch.delivery.id })
    const next = insert('written after downgrade')
    const nextBatch = db.getOrCreateRunDelivery(params)!
    expect(nextBatch.messages.map((message) => message.id)).toEqual([next.id])
    db.close()

    db = new OrchestrationDb(path)
    expect(db.getOrCreateRunDelivery(params)?.delivery.id).toBe(nextBatch.delivery.id)
    db.acknowledgeRunDelivery({ ...params, deliveryId: nextBatch.delivery.id })
    expect(db.getOrCreateRunDelivery(params)).toBeUndefined()
  } finally {
    db?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
