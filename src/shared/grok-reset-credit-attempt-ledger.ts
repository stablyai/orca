import { z } from 'zod'
import type { CodexRateLimitResetOutcome, RateLimitWindow } from './rate-limit-types'

export const MAX_SETTLED_GROK_RESET_CREDIT_ATTEMPTS = 100

const GrokResetPreOperationWeeklySnapshotSchema = z
  .object({
    usedPercent: z.number(),
    windowMinutes: z.number(),
    resetsAt: z.number().nullable(),
    resetDescription: z.string().nullable()
  })
  .strict()

const DurableGrokResetCreditAttemptSchema = z.discriminatedUnion('state', [
  z
    .object({
      idempotencyKey: z.uuid(),
      state: z.literal('providerPending'),
      preOperationWeekly: GrokResetPreOperationWeeklySnapshotSchema.nullable().optional()
    })
    .strict(),
  z
    .object({
      idempotencyKey: z.uuid(),
      state: z.literal('settled'),
      outcome: z.enum(['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'])
    })
    .strict()
])

const GrokResetCreditAttemptLedgerSchema = z
  .object({
    version: z.literal(1),
    attempts: z.array(DurableGrokResetCreditAttemptSchema).max(1_000)
  })
  .strict()
  .superRefine((ledger, context) => {
    const keys = new Set<string>()
    for (const [index, attempt] of ledger.attempts.entries()) {
      if (keys.has(attempt.idempotencyKey)) {
        context.addIssue({
          code: 'custom',
          message: 'Duplicate idempotency key',
          path: ['attempts', index, 'idempotencyKey']
        })
      }
      keys.add(attempt.idempotencyKey)
    }
  })

export type DurableGrokResetCreditAttempt =
  | {
      idempotencyKey: string
      state: 'providerPending'
      preOperationWeekly?: RateLimitWindow | null
    }
  | {
      idempotencyKey: string
      state: 'settled'
      outcome: CodexRateLimitResetOutcome
    }

export type GrokResetCreditAttemptLedger = {
  version: 1
  attempts: DurableGrokResetCreditAttempt[]
}

export const EMPTY_GROK_RESET_CREDIT_ATTEMPT_LEDGER: GrokResetCreditAttemptLedger = {
  version: 1,
  attempts: []
}

export function parseGrokResetCreditAttemptLedger(value: unknown): GrokResetCreditAttemptLedger {
  if (value === undefined) {
    return structuredClone(EMPTY_GROK_RESET_CREDIT_ATTEMPT_LEDGER)
  }
  const parsed = GrokResetCreditAttemptLedgerSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error('Grok reset-credit attempt ledger is corrupt')
  }
  return structuredClone(parsed.data) as GrokResetCreditAttemptLedger
}
