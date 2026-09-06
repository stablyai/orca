import { z } from 'zod'

export const MOBILE_WEB_ACCOUNT_LIMIT = 32

const AccountIdSchema = z.string().min(1).max(256)
const AccountEmailSchema = z.string().min(1).max(320)
const OptionalLabelSchema = z.string().max(240).nullable().optional()
const TimestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const MobileWebRateLimitRuntimeTargetSchema = z
  .object({
    runtime: z.enum(['host', 'wsl']),
    wslDistro: z.string().min(1).max(255).nullable()
  })
  .strict()
  .superRefine((target, context) => {
    if (target.runtime === 'host' && target.wslDistro !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Host targets cannot name a WSL distro',
        path: ['wslDistro']
      })
    }
    if (
      target.runtime === 'wsl' &&
      target.wslDistro !== null &&
      target.wslDistro.trim() !== target.wslDistro
    ) {
      context.addIssue({
        code: 'custom',
        message: 'WSL targets require an exact distro',
        path: ['wslDistro']
      })
    }
  })

const MobileWebRuntimeSelectionSchema = z
  .object({
    host: AccountIdSchema.nullable(),
    wsl: z
      .record(z.string().min(1).max(255), AccountIdSchema.nullable())
      .refine((entries) => Object.keys(entries).length <= MOBILE_WEB_ACCOUNT_LIMIT)
  })
  .strict()

const MobileWebRateLimitWindowSchema = z
  .object({
    usedPercent: z.number().finite().min(0).max(100),
    windowMinutes: z.number().int().nonnegative().max(1_000_000),
    resetsAt: TimestampSchema.nullable(),
    resetDescription: z.string().max(240).nullable()
  })
  .strict()

const MobileWebRateLimitResetCreditSchema = z
  .object({
    status: z.string().min(1).max(64),
    expiresAt: TimestampSchema.nullable(),
    grantedAt: TimestampSchema.nullable()
  })
  .strict()

const MobileWebRateLimitResetCreditsSchema = z
  .object({
    availableCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    totalEarnedCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    nextExpiresAt: TimestampSchema.nullable().optional(),
    credits: z.array(MobileWebRateLimitResetCreditSchema).max(MOBILE_WEB_ACCOUNT_LIMIT).optional()
  })
  .strict()

const MobileWebProviderRateLimitsSchema = z
  .object({
    provider: z.enum(['claude', 'codex']),
    session: MobileWebRateLimitWindowSchema.nullable(),
    weekly: MobileWebRateLimitWindowSchema.nullable(),
    fableWeekly: MobileWebRateLimitWindowSchema.nullable().optional(),
    monthly: MobileWebRateLimitWindowSchema.nullable().optional(),
    buckets: z
      .array(
        MobileWebRateLimitWindowSchema.extend({
          name: z.string().min(1).max(240)
        }).strict()
      )
      .max(MOBILE_WEB_ACCOUNT_LIMIT)
      .optional(),
    rateLimitResetCredits: MobileWebRateLimitResetCreditsSchema.nullable().optional(),
    updatedAt: TimestampSchema,
    error: z.string().max(512).nullable(),
    status: z.enum(['idle', 'fetching', 'ok', 'error', 'unavailable'])
  })
  .strict()

const MobileWebInactiveAccountUsageSchema = z
  .object({
    accountId: AccountIdSchema,
    rateLimits: MobileWebProviderRateLimitsSchema.nullable(),
    updatedAt: TimestampSchema,
    isFetching: z.boolean()
  })
  .strict()

const MobileWebClaudeAccountSchema = z
  .object({
    id: AccountIdSchema,
    email: AccountEmailSchema,
    managedAuthRuntime: z.enum(['host', 'wsl']).optional(),
    wslDistro: z.string().max(255).nullable().optional(),
    authMethod: z.enum(['subscription-oauth', 'unknown']).optional(),
    organizationUuid: z.string().max(256).nullable().optional(),
    organizationName: OptionalLabelSchema,
    createdAt: TimestampSchema.optional(),
    updatedAt: TimestampSchema.optional(),
    lastAuthenticatedAt: TimestampSchema.optional()
  })
  .strict()

const MobileWebCodexAccountSchema = z
  .object({
    id: AccountIdSchema,
    email: AccountEmailSchema,
    managedHomeRuntime: z.enum(['host', 'wsl']).optional(),
    wslDistro: z.string().max(255).nullable().optional(),
    workspaceLabel: OptionalLabelSchema,
    workspaceAccountId: z.string().max(256).nullable().optional(),
    createdAt: TimestampSchema.optional(),
    updatedAt: TimestampSchema,
    lastAuthenticatedAt: TimestampSchema.optional()
  })
  .strict()

export const MobileWebAccountsSnapshotSchema = z
  .object({
    claude: z
      .object({
        accounts: z.array(MobileWebClaudeAccountSchema).max(MOBILE_WEB_ACCOUNT_LIMIT),
        activeAccountId: AccountIdSchema.nullable(),
        activeAccountIdsByRuntime: MobileWebRuntimeSelectionSchema.optional()
      })
      .strict(),
    codex: z
      .object({
        accounts: z.array(MobileWebCodexAccountSchema).max(MOBILE_WEB_ACCOUNT_LIMIT),
        activeAccountId: AccountIdSchema.nullable(),
        activeAccountIdsByRuntime: MobileWebRuntimeSelectionSchema.optional()
      })
      .strict(),
    rateLimits: z
      .object({
        claude: MobileWebProviderRateLimitsSchema.nullable(),
        codex: MobileWebProviderRateLimitsSchema.nullable(),
        claudeTarget: MobileWebRateLimitRuntimeTargetSchema,
        codexTarget: MobileWebRateLimitRuntimeTargetSchema,
        inactiveClaudeAccounts: z
          .array(MobileWebInactiveAccountUsageSchema)
          .max(MOBILE_WEB_ACCOUNT_LIMIT),
        inactiveCodexAccounts: z
          .array(MobileWebInactiveAccountUsageSchema)
          .max(MOBILE_WEB_ACCOUNT_LIMIT)
      })
      .strict()
  })
  .strict()

export const MobileWebCodexResetCreditExpectedScopeSchema = z
  .object({
    target: MobileWebRateLimitRuntimeTargetSchema,
    accountId: z.string().min(1).max(512),
    accountRevision: TimestampSchema,
    offerRevision: z.string().startsWith('v1:').max(4_096)
  })
  .strict()
  .superRefine((scope, context) => {
    if (scope.target.runtime === 'wsl' && scope.target.wslDistro === null) {
      context.addIssue({
        code: 'custom',
        message: 'WSL reset scopes require a distro',
        path: ['target', 'wslDistro']
      })
    }
  })

export const MobileWebAccountSnapshotPayloadSchema = z.object({}).strict()
export const MobileWebAccountSelectPayloadSchema = z
  .object({
    provider: z.enum(['claude', 'codex']),
    accountId: AccountIdSchema.nullable(),
    codexTarget: MobileWebRateLimitRuntimeTargetSchema.optional()
  })
  .strict()
export const MobileWebAccountSelectResultSchema = z.null()
export const MobileWebAccountResetCapabilityPayloadSchema = z.object({}).strict()
export const MobileWebAccountResetCapabilityResultSchema = z.boolean()
export const MobileWebAccountConsumeResetPayloadSchema = z
  .object({
    expectedScope: MobileWebCodexResetCreditExpectedScopeSchema
  })
  .strict()

const MobileWebAccountConsumedResetResultSchema = z
  .object({
    outcome: z.enum(['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed']),
    scope: MobileWebCodexResetCreditExpectedScopeSchema,
    snapshot: MobileWebAccountsSnapshotSchema,
    attemptJournalRetained: z.boolean()
  })
  .strict()

const MobileWebAccountRejectedResetResultSchema = z
  .object({
    status: z.literal('rejectedBeforeProvider'),
    retryDisposition: z.literal('discardAttempt'),
    reason: z.enum([
      'targetChanged',
      'accountChanged',
      'accountRevisionChanged',
      'accountRuntimeChanged',
      'offerUnavailable',
      'offerChanged'
    ]),
    scope: MobileWebCodexResetCreditExpectedScopeSchema,
    snapshot: MobileWebAccountsSnapshotSchema,
    attemptJournalRetained: z.boolean()
  })
  .strict()

export const MobileWebAccountConsumeResetResultSchema = z.union([
  MobileWebAccountConsumedResetResultSchema,
  MobileWebAccountRejectedResetResultSchema
])
export const MobileWebAccountSubscribePayloadSchema = z.object({}).strict()
export const MobileWebAccountEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.enum(['ready', 'snapshot']),
      snapshot: MobileWebAccountsSnapshotSchema
    })
    .strict(),
  z.object({ type: z.enum(['end', 'error']) }).strict()
])

export type MobileWebAccountsSnapshot = z.infer<typeof MobileWebAccountsSnapshotSchema>
export type MobileWebAccountSelectPayload = z.infer<typeof MobileWebAccountSelectPayloadSchema>
export type MobileWebAccountConsumeResetPayload = z.infer<
  typeof MobileWebAccountConsumeResetPayloadSchema
>
export type MobileWebAccountConsumeResetResult = z.infer<
  typeof MobileWebAccountConsumeResetResultSchema
>
export type MobileWebAccountEvent = z.infer<typeof MobileWebAccountEventSchema>
