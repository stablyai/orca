import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

export const ManagedDataAccountProviderParams = lazyZodSchema(() =>
  z.object({
    provider: z.enum(['opencode', 'devin'])
  })
)
export const AddDataAccountParams = lazyZodSchema(() =>
  ManagedDataAccountProviderParams.extend({
    sourceDataHome: z.string().min(1),
    label: z.string().trim().min(1).max(120)
  })
)
export const SelectDataAccountParams = lazyZodSchema(() =>
  ManagedDataAccountProviderParams.extend({
    accountId: z.uuid().nullable()
  })
)
export const RemoveDataAccountParams = lazyZodSchema(() =>
  ManagedDataAccountProviderParams.extend({
    accountId: z.uuid()
  })
)

export const CodexResetTarget = lazyZodSchema(() =>
  z.discriminatedUnion('runtime', [
    z.object({ runtime: z.literal('host'), wslDistro: z.null() }).strict(),
    // Why: reset scope must identify one exact WSL distro; null means all slots only for selection.
    z.object({ runtime: z.literal('wsl'), wslDistro: z.string().trim().min(1).max(255) }).strict()
  ])
)

export const CodexSelectionTarget = lazyZodSchema(() =>
  z.discriminatedUnion('runtime', [
    z.object({ runtime: z.literal('host'), wslDistro: z.null() }).strict(),
    z
      .object({
        runtime: z.literal('wsl'),
        // A null distro intentionally means all WSL selection slots.
        wslDistro: z.string().trim().min(1).max(255).nullable()
      })
      .strict()
  ])
)

export const SelectAccountParams = lazyZodSchema(() =>
  z.object({
    accountId: z
      .union([z.string().min(1, 'Missing accountId'), z.null()])
      .transform((v) => (v === null ? null : v))
  })
)

export const SelectClaudeAccountParams = lazyZodSchema(() =>
  SelectAccountParams.extend({
    // The web client moves running sessions in its own window; older hosts strip this.
    movesRunningSessions: z.literal(true).optional(),
    // The switching client's own choice for the host's running terminals; older hosts strip this.
    runningSessions: z.enum(['ask', 'restart', 'keep']).optional(),
    // Answers the Ask an earlier switch to this account left open; never switches accounts itself.
    answersAsk: z.literal(true).optional(),
    // Identifies the Ask being answered so an older toast cannot stop a later switch's sessions.
    answersAskId: z.string().min(1).optional()
  })
)

export const SelectCodexAccountForTargetParams = lazyZodSchema(() =>
  SelectAccountParams.extend({
    target: CodexSelectionTarget
  })
)

export const RemoveAccountParams = lazyZodSchema(() =>
  z.object({
    accountId: z.string().min(1, 'Missing accountId')
  })
)

// Blank clears the name; the service enforces the length limit with a readable error.
export const RenameAccountParams = lazyZodSchema(() =>
  z.object({
    accountId: z.string().min(1, 'Missing accountId'),
    displayName: z.string().nullable()
  })
)

export const CodexResetExpectedScope = lazyZodSchema(() =>
  z
    .object({
      target: CodexResetTarget,
      accountId: z.string().min(1, 'Missing accountId').max(512),
      accountRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      offerRevision: z.string().startsWith('v1:', 'Invalid offerRevision').max(4_096)
    })
    .strict()
)

export const ConsumeCodexResetCreditParams = lazyZodSchema(() =>
  z
    .object({
      // Retries share a host-ledger attempt so the same offer/account never spends a credit twice.
      idempotencyKey: z.uuid('Invalid idempotencyKey'),
      expectedScope: CodexResetExpectedScope
    })
    .strict()
)

export const AddClaudeFromConfigDirParams = lazyZodSchema(() =>
  z.object({
    configDir: z.string().min(1, 'Missing configDir'),
    runtime: z.enum(['host', 'wsl']).optional(),
    wslDistro: z.string().nullish(),
    previousLegacyCredentialsSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/, 'Invalid legacy credential digest')
      .nullable()
      .optional()
  })
)

export const AddCodexFromHomeParams = lazyZodSchema(() =>
  z.object({
    sourceHome: z.string().min(1, 'Missing sourceHome'),
    runtime: z.enum(['host', 'wsl']).optional(),
    wslDistro: z.string().nullish()
  })
)

// Account list opts out: forced usage refresh bypasses throttle/Retry-After and costs a serial round trip per account.
export const ListAccountsParams = lazyZodSchema(() =>
  z.object({
    refreshUsage: z.boolean().default(true),
    // Older hosts strip this and skip the refresh, which matches their prior behavior.
    refreshStaleUsage: z.boolean().optional()
  })
)

export const AccountsUnsubscribeParams = lazyZodSchema(() =>
  z.object({
    subscriptionId: z
      .unknown()
      .transform((value) => (typeof value === 'string' && value.length > 0 ? value : ''))
      .pipe(z.string().min(1, 'Missing subscriptionId'))
  })
)

const claudeSignInTarget = () => ({
  runtime: z.enum(['host', 'wsl']).optional(),
  wslDistro: z.string().nullish()
})

export const BeginClaudeSignInParams = lazyZodSchema(() =>
  z.object({ accountId: z.string().min(1).optional(), ...claudeSignInTarget() }).strict()
)

export const FinishClaudeSignInParams = lazyZodSchema(() =>
  z.object({ accountId: z.string().min(1), ...claudeSignInTarget() }).strict()
)

export const HostAccountSignInStartParams = lazyZodSchema(() =>
  z.object({
    provider: z.enum(['claude', 'codex']),
    /** Re-authenticates this saved account instead of adding one; send only to hosts with the reauth capability. */
    accountId: z.string().min(1).max(128).optional()
  })
)

export const HostAccountSignInWaitParams = lazyZodSchema(() =>
  z.object({
    flowId: z.string().min(1).max(64),
    afterRevision: z.number().int().nonnegative().default(0)
  })
)

export const HostAccountSignInFlowParams = lazyZodSchema(() =>
  z.object({ flowId: z.string().min(1).max(64) })
)

export const HostAccountSignInCodeParams = lazyZodSchema(() =>
  HostAccountSignInFlowParams.extend({
    code: z
      .string()
      .trim()
      .min(1, 'Paste the code from the sign-in page.')
      .max(4_096)
      // Why: the code becomes one line on the login's stdin; a newline inside it would answer twice.
      .regex(/^[^\s\p{Cc}]+$/u, 'That code has spaces or line breaks in it. Copy it again.')
  })
)
