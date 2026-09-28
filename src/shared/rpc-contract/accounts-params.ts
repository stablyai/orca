import { z } from 'zod'

export const CodexResetTarget = z.discriminatedUnion('runtime', [
  z.object({ runtime: z.literal('host'), wslDistro: z.null() }).strict(),
  // Why: reset scope must identify one exact WSL distro; null means all slots only for selection.
  z.object({ runtime: z.literal('wsl'), wslDistro: z.string().trim().min(1).max(255) }).strict()
])

export const CodexSelectionTarget = z.discriminatedUnion('runtime', [
  z.object({ runtime: z.literal('host'), wslDistro: z.null() }).strict(),
  z
    .object({
      runtime: z.literal('wsl'),
      // A null distro intentionally means all WSL selection slots.
      wslDistro: z.string().trim().min(1).max(255).nullable()
    })
    .strict()
])

export const SelectAccountParams = z.object({
  accountId: z
    .union([z.string().min(1, 'Missing accountId'), z.null()])
    .transform((v) => (v === null ? null : v))
})

export const SelectCodexAccountForTargetParams = SelectAccountParams.extend({
  target: CodexSelectionTarget
})

export const RemoveAccountParams = z.object({
  accountId: z.string().min(1, 'Missing accountId')
})

export const CodexResetExpectedScope = z
  .object({
    target: CodexResetTarget,
    accountId: z.string().min(1, 'Missing accountId').max(512),
    accountRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    offerRevision: z.string().startsWith('v1:', 'Invalid offerRevision').max(4_096)
  })
  .strict()

export const ConsumeCodexResetCreditParams = z
  .object({
    // Why: the phone owns the logical attempt key so a lost response can be
    // retried without spending a finite earned credit twice.
    idempotencyKey: z.uuid('Invalid idempotencyKey'),
    expectedScope: CodexResetExpectedScope
  })
  .strict()

export const AddClaudeFromConfigDirParams = z.object({
  configDir: z.string().min(1, 'Missing configDir'),
  runtime: z.enum(['host', 'wsl']).optional(),
  wslDistro: z.string().nullish(),
  previousLegacyCredentialsSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/, 'Invalid legacy credential digest')
    .nullable()
    .optional()
})

export const AddCodexFromHomeParams = z.object({
  sourceHome: z.string().min(1, 'Missing sourceHome'),
  runtime: z.enum(['host', 'wsl']).optional(),
  wslDistro: z.string().nullish()
})

// Why: `orca account list` prints only emails and the active ids, so it opts out
// of the forced all-provider usage refresh below — that lane bypasses the poll
// throttle and Retry-After gate and costs one serial round-trip per account.
export const ListAccountsParams = z.object({
  refreshUsage: z.boolean().default(true)
})

export const AccountsUnsubscribeParams = z.object({
  subscriptionId: z
    .unknown()
    .transform((value) => (typeof value === 'string' && value.length > 0 ? value : ''))
    .pipe(z.string().min(1, 'Missing subscriptionId'))
})
