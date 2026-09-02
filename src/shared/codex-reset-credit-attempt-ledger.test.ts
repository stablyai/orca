import { describe, expect, it } from 'vitest'
import {
  EMPTY_CODEX_RESET_CREDIT_ATTEMPT_LEDGER,
  parseCodexResetCreditAttemptLedger
} from './codex-reset-credit-attempt-ledger'

const hostScope = {
  target: { runtime: 'host' as const, wslDistro: null },
  accountId: 'account-host',
  accountRevision: 42,
  offerRevision: 'v1:offer-host'
}

describe('Codex reset credit attempt ledger', () => {
  it('strictly accepts pending and settled durable attempts', () => {
    expect(
      parseCodexResetCreditAttemptLedger({
        version: 1,
        attempts: [
          {
            idempotencyKey: '11111111-1111-4111-8111-111111111111',
            expectedScope: hostScope,
            state: 'providerPending'
          },
          {
            idempotencyKey: '22222222-2222-4222-8222-222222222222',
            expectedScope: {
              ...hostScope,
              offerRevision: 'v1:offer-settled'
            },
            state: 'settled',
            outcome: 'alreadyRedeemed'
          }
        ]
      })
    ).toMatchObject({ version: 1, attempts: [{ state: 'providerPending' }, { state: 'settled' }] })
    expect(parseCodexResetCreditAttemptLedger(undefined)).toEqual(
      EMPTY_CODEX_RESET_CREDIT_ATTEMPT_LEDGER
    )
  })

  it.each([
    {
      name: 'unknown field',
      value: { version: 1, attempts: [], extra: true }
    },
    {
      name: 'duplicate idempotency key',
      value: {
        version: 1,
        attempts: [
          {
            idempotencyKey: '11111111-1111-4111-8111-111111111111',
            expectedScope: hostScope,
            state: 'providerPending'
          },
          {
            idempotencyKey: '11111111-1111-4111-8111-111111111111',
            expectedScope: { ...hostScope, offerRevision: 'v1:other' },
            state: 'settled',
            outcome: 'reset'
          }
        ]
      }
    },
    {
      name: 'duplicate claimed offer',
      value: {
        version: 1,
        attempts: [
          {
            idempotencyKey: '11111111-1111-4111-8111-111111111111',
            expectedScope: hostScope,
            state: 'settled',
            outcome: 'reset'
          },
          {
            idempotencyKey: '22222222-2222-4222-8222-222222222222',
            expectedScope: hostScope,
            state: 'settled',
            outcome: 'alreadyRedeemed'
          }
        ]
      }
    },
    {
      name: 'duplicate pending account scope',
      value: {
        version: 1,
        attempts: [
          {
            idempotencyKey: '11111111-1111-4111-8111-111111111111',
            expectedScope: hostScope,
            state: 'providerPending'
          },
          {
            idempotencyKey: '22222222-2222-4222-8222-222222222222',
            expectedScope: { ...hostScope, offerRevision: 'v1:other' },
            state: 'providerPending'
          }
        ]
      }
    },
    {
      name: 'invalid WSL target',
      value: {
        version: 1,
        attempts: [
          {
            idempotencyKey: '11111111-1111-4111-8111-111111111111',
            expectedScope: {
              ...hostScope,
              target: { runtime: 'wsl', wslDistro: null }
            },
            state: 'providerPending'
          }
        ]
      }
    }
  ])('rejects $name as a corrupt ledger', ({ value }) => {
    expect(() => parseCodexResetCreditAttemptLedger(value)).toThrow(
      'Codex reset-credit attempt ledger is corrupt'
    )
  })
})
