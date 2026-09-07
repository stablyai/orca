import { z } from 'zod'
import type { CodexRateLimitResetOutcome } from './rate-limit-types'
import type { CodexResetCreditExpectedScope } from './codex-reset-credit-scope'

const CodexResetCreditTargetSchema = z.discriminatedUnion('runtime', [
  z.object({ runtime: z.literal('host'), wslDistro: z.null() }).strict(),
  z.object({ runtime: z.literal('wsl'), wslDistro: z.string().trim().min(1).max(255) }).strict()
])

const CodexResetCreditExpectedScopeSchema = z
  .object({
    target: CodexResetCreditTargetSchema,
    accountId: z.string().min(1).max(512),
    accountRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    offerRevision: z.string().startsWith('v1:').max(4_096)
  })
  .strict()

const DurableCodexResetCreditAttemptSchema = z.discriminatedUnion('state', [
  z
    .object({
      idempotencyKey: z.uuid(),
      expectedScope: CodexResetCreditExpectedScopeSchema,
      state: z.literal('providerPending')
    })
    .strict(),
  z
    .object({
      idempotencyKey: z.uuid(),
      expectedScope: CodexResetCreditExpectedScopeSchema,
      state: z.literal('settled'),
      outcome: z.enum(['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'])
    })
    .strict()
])

const CodexResetCreditAttemptLedgerSchema = z
  .object({
    version: z.literal(1),
    attempts: z.array(DurableCodexResetCreditAttemptSchema).max(10_000)
  })
  .strict()
  .superRefine((ledger, context) => {
    const keys = new Set<string>()
    const offers = new Set<string>()
    const pendingAccountScopes = new Set<string>()
    for (const [index, attempt] of ledger.attempts.entries()) {
      const offerScope = JSON.stringify([
        attempt.expectedScope.target.runtime,
        attempt.expectedScope.target.wslDistro,
        attempt.expectedScope.accountId,
        attempt.expectedScope.accountRevision,
        attempt.expectedScope.offerRevision
      ])
      const accountScope = JSON.stringify([
        attempt.expectedScope.target.runtime,
        attempt.expectedScope.target.wslDistro,
        attempt.expectedScope.accountId,
        attempt.expectedScope.accountRevision
      ])
      if (keys.has(attempt.idempotencyKey)) {
        context.addIssue({
          code: 'custom',
          message: 'Duplicate idempotency key',
          path: ['attempts', index, 'idempotencyKey']
        })
      }
      if (offers.has(offerScope)) {
        context.addIssue({
          code: 'custom',
          message: 'Duplicate claimed offer',
          path: ['attempts', index, 'expectedScope']
        })
      }
      if (attempt.state === 'providerPending' && pendingAccountScopes.has(accountScope)) {
        context.addIssue({
          code: 'custom',
          message: 'Duplicate pending account scope',
          path: ['attempts', index, 'expectedScope']
        })
      }
      keys.add(attempt.idempotencyKey)
      offers.add(offerScope)
      if (attempt.state === 'providerPending') {
        pendingAccountScopes.add(accountScope)
      }
    }
  })

export type DurableCodexResetCreditAttempt =
  | {
      idempotencyKey: string
      expectedScope: CodexResetCreditExpectedScope
      state: 'providerPending'
    }
  | {
      idempotencyKey: string
      expectedScope: CodexResetCreditExpectedScope
      state: 'settled'
      outcome: CodexRateLimitResetOutcome
    }

export type CodexResetCreditAttemptLedger = {
  version: 1
  attempts: DurableCodexResetCreditAttempt[]
}

export const EMPTY_CODEX_RESET_CREDIT_ATTEMPT_LEDGER: CodexResetCreditAttemptLedger = {
  version: 1,
  attempts: []
}

export function parseCodexResetCreditAttemptLedger(value: unknown): CodexResetCreditAttemptLedger {
  if (value === undefined) {
    return { version: 1, attempts: [] }
  }
  const parsed = CodexResetCreditAttemptLedgerSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error('Codex reset-credit attempt ledger is corrupt')
  }
  return structuredClone(parsed.data) as CodexResetCreditAttemptLedger
}
