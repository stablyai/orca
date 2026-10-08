import { describe, expect, it } from 'vitest'
import {
  OrcadManagedStopCancellationSchema,
  OrcadManagedStopCompletionSchema
} from './orcad-stop-request'

const request = {
  schemaVersion: 1,
  transactionId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  version: '1.0.0',
  runtimeId: 'runtime-1',
  instance: { pid: 42, startedAtMs: null, nonce: 'nonce', lockPath: '/tmp/lock' }
}

describe('managed stop replies from a newer slot', () => {
  it('degrade unknown arms and ignore unknown fields', () => {
    const newer = { ...request, instance: { ...request.instance, futureField: 1 }, futureField: 1 }

    expect(
      OrcadManagedStopCompletionSchema.parse({
        ...newer,
        kind: 'orcad_managed_stop_completion',
        verdict: 'future-verdict',
        receiptPersisted: true,
        retirement: 'future-retirement'
      })
    ).toMatchObject({ verdict: 'unverifiable', retirement: 'unverifiable' })
    expect(
      OrcadManagedStopCancellationSchema.parse({
        ...newer,
        kind: 'orcad_managed_stop_cancellation',
        outcome: 'future-outcome'
      })
    ).toMatchObject({ outcome: 'dispatched' })
  })

  it('still rejects a missing verdict', () => {
    expect(() =>
      OrcadManagedStopCompletionSchema.parse({
        ...request,
        kind: 'orcad_managed_stop_completion',
        receiptPersisted: true
      })
    ).toThrow()
  })
})
