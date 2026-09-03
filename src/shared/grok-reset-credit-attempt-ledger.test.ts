import { describe, expect, it } from 'vitest'
import {
  EMPTY_GROK_RESET_CREDIT_ATTEMPT_LEDGER,
  parseGrokResetCreditAttemptLedger
} from './grok-reset-credit-attempt-ledger'

describe('parseGrokResetCreditAttemptLedger', () => {
  it('accepts pending and settled durable attempts', () => {
    expect(
      parseGrokResetCreditAttemptLedger({
        version: 1,
        attempts: [
          { idempotencyKey: '11111111-1111-4111-8111-111111111111', state: 'providerPending' },
          {
            idempotencyKey: '33333333-3333-4333-8333-333333333333',
            state: 'providerPending',
            preOperationWeekly: {
              usedPercent: 80,
              windowMinutes: 10_080,
              resetsAt: null,
              resetDescription: null
            }
          },
          {
            idempotencyKey: '22222222-2222-4222-8222-222222222222',
            state: 'settled',
            outcome: 'reset'
          }
        ]
      })
    ).toMatchObject({
      attempts: [
        { state: 'providerPending' },
        { state: 'providerPending', preOperationWeekly: { usedPercent: 80 } },
        { state: 'settled' }
      ]
    })
  })

  it('defaults missing persisted state and rejects duplicate keys', () => {
    expect(parseGrokResetCreditAttemptLedger(undefined)).toEqual(
      EMPTY_GROK_RESET_CREDIT_ATTEMPT_LEDGER
    )
    expect(() =>
      parseGrokResetCreditAttemptLedger({
        version: 1,
        attempts: [
          { idempotencyKey: '11111111-1111-4111-8111-111111111111', state: 'providerPending' },
          {
            idempotencyKey: '11111111-1111-4111-8111-111111111111',
            state: 'settled',
            outcome: 'reset'
          }
        ]
      })
    ).toThrow('Grok reset-credit attempt ledger is corrupt')
  })
})
