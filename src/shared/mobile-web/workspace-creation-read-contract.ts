import { z } from 'zod'
import { isMobileWebSha256 } from './protocol-token-contract'

export type MobileWebExecutionHostId = 'local' | `ssh:${string}` | `runtime:${string}`

export const MobileWebCreationRepoIdSchema = z.string().min(1).max(128)
const EmptyPayloadSchema = z.object({}).strict()

const TrustedHookEntrySchema = z
  .object({
    contentHash: z.string().refine(isMobileWebSha256),
    approvedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()
const TrustedHookRepoSchema = z
  .object({
    all: z
      .object({ approvedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
      .strict()
      .optional(),
    setup: TrustedHookEntrySchema.optional(),
    archive: TrustedHookEntrySchema.optional(),
    issueCommand: TrustedHookEntrySchema.optional(),
    vmRecipe: TrustedHookEntrySchema.optional()
  })
  .strict()

export const MobileWebCreationRepositoriesPayloadSchema = EmptyPayloadSchema
export const MobileWebCreationRepositoriesResultSchema = z
  .object({
    repositories: z
      .array(
        z
          .object({
            id: MobileWebCreationRepoIdSchema,
            displayName: z.string().min(1).max(240),
            path: z.string().max(4_096),
            badgeColor: z.string().max(64).optional(),
            connectionId: MobileWebCreationRepoIdSchema.nullable().optional(),
            executionHostId: z.custom<MobileWebExecutionHostId>(
              (value) =>
                value === 'local' ||
                (typeof value === 'string' &&
                  (value.startsWith('ssh:executionHost_') ||
                    value.startsWith('runtime:executionHost_')))
            ),
            executionHostLabel: z.string().min(1).max(240),
            projectId: z.string().min(1).max(128),
            upstream: z
              .object({
                owner: z.string().min(1).max(240),
                repo: z.string().min(1).max(240),
                host: z.string().min(1).max(240).optional()
              })
              .strict()
              .nullable()
              .optional(),
            kind: z.enum(['git', 'folder']).optional()
          })
          .strict()
      )
      .max(10_000)
  })
  .strict()

export const MobileWebCreationSettingsPayloadSchema = EmptyPayloadSchema
export const MobileWebCreationSettingsResultSchema = z
  .object({
    defaultTuiAgent: z.string().min(1).max(64).nullable().optional(),
    disabledTuiAgents: z.array(z.string().min(1).max(64)).max(64).optional(),
    visibleTaskProviders: z
      .array(z.enum(['github', 'gitlab', 'linear']))
      .max(3)
      .optional()
  })
  .strict()

export const MobileWebCreationTrustedHooksPayloadSchema = EmptyPayloadSchema
export const MobileWebCreationTrustedHooksResultSchema = z.record(
  MobileWebCreationRepoIdSchema,
  TrustedHookRepoSchema
)

export const MobileWebCreationAvailabilityPayloadSchema = EmptyPayloadSchema
export const MobileWebCreationAvailabilityResultSchema = z
  .object({ available: z.boolean() })
  .strict()

export const MobileWebCreationRepoPayloadSchema = z
  .object({ repoId: MobileWebCreationRepoIdSchema })
  .strict()
export const MobileWebCreationRetiredNamesResultSchema = z
  .object({
    exhaustedTiers: z.number().int().nonnegative().max(999_999),
    names: z.array(z.string().min(1).max(240)).max(1_000)
  })
  .strict()
export const MobileWebCreationAgentDetectionPayloadSchema = z
  .object({ repoId: MobileWebCreationRepoIdSchema.nullable() })
  .strict()
export const MobileWebCreationAgentDetectionResultSchema = z
  .object({ agentIds: z.array(z.string().min(1).max(64)).max(64) })
  .strict()

export const MobileWebCreationSshStateResultSchema = z
  .object({
    targetId: MobileWebCreationRepoIdSchema,
    status: z.enum([
      'disconnected',
      'connecting',
      'auth-failed',
      'deploying-relay',
      'connected',
      'reconnecting',
      'reconnection-failed',
      'error'
    ]),
    error: z.string().max(160).nullable(),
    reconnectAttempt: z.number().int().nonnegative().max(1_000_000),
    supportsFolderDownload: z.boolean().optional(),
    remotePlatform: z.enum(['linux', 'darwin', 'win32']).optional()
  })
  .strict()

export const MobileWebCreationRepoHooksResultSchema = z
  .object({
    hooks: z
      .object({
        scripts: z
          .object({
            setup: z
              .string()
              .max(64 * 1024)
              .optional()
          })
          .strict()
          .optional()
      })
      .strict()
      .nullable(),
    source: z.string().max(80).nullable(),
    setupRunPolicy: z.enum(['ask', 'run-by-default', 'skip-by-default']).optional(),
    setupTrust: z
      .object({
        contentHash: z.string().refine(isMobileWebSha256),
        scriptContent: z.string().max(64 * 1024)
      })
      .strict()
      .optional()
  })
  .strict()

export const MobileWebCreationRuntimeCapabilitiesPayloadSchema = EmptyPayloadSchema
export const MobileWebCreationRuntimeCapabilitiesResultSchema = z
  .object({
    tasksSupported: z.boolean(),
    idempotentWorktreeCreateSupported: z.boolean(),
    worktreeCreateIdempotency: z
      .object({ dedupeTtlMs: z.number().int().nonnegative() })
      .strict()
      .or(z.literal(false)),
    hostPlatform: z
      .enum([
        'aix',
        'android',
        'darwin',
        'freebsd',
        'haiku',
        'linux',
        'openbsd',
        'sunos',
        'win32',
        'cygwin',
        'netbsd'
      ])
      .nullable()
  })
  .strict()

export const MobileWebCreationSparsePresetsResultSchema = z
  .object({
    presets: z
      .array(
        z
          .object({
            id: z.string().min(1).max(240),
            repoId: MobileWebCreationRepoIdSchema,
            name: z.string().min(1).max(240),
            directories: z.array(z.string().min(1).max(4_096)).max(1_000),
            createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
          })
          .strict()
      )
      .max(1_000)
  })
  .strict()
export const MobileWebCreationSparsePresetSavePayloadSchema = z
  .object({
    repoId: MobileWebCreationRepoIdSchema,
    id: z.string().min(1).max(240).optional(),
    name: z.string().trim().min(1).max(240),
    directories: z.array(z.string().min(1).max(4_096)).min(1).max(1_000)
  })
  .strict()
export const MobileWebCreationSparsePresetSaveResultSchema = z
  .object({ preset: MobileWebCreationSparsePresetsResultSchema.shape.presets.element })
  .strict()

export const MobileWebCreationPersistTrustPayloadSchema = z
  .object({
    trust: MobileWebCreationTrustedHooksResultSchema,
    repoId: MobileWebCreationRepoIdSchema,
    contentHash: z.string().refine(isMobileWebSha256),
    alwaysTrust: z.boolean()
  })
  .strict()

export type MobileWebCreationRepositoriesResult = z.infer<
  typeof MobileWebCreationRepositoriesResultSchema
>
export type MobileWebCreationSettingsResult = z.infer<typeof MobileWebCreationSettingsResultSchema>
export type MobileWebCreationRuntimeCapabilitiesResult = z.infer<
  typeof MobileWebCreationRuntimeCapabilitiesResultSchema
>
export type MobileWebCreationTrustedHooksResult = z.infer<
  typeof MobileWebCreationTrustedHooksResultSchema
>
export type MobileWebCreationRepoPayload = z.infer<typeof MobileWebCreationRepoPayloadSchema>
export type MobileWebCreationRetiredNamesResult = z.infer<
  typeof MobileWebCreationRetiredNamesResultSchema
>
export type MobileWebCreationAgentDetectionPayload = z.infer<
  typeof MobileWebCreationAgentDetectionPayloadSchema
>
export type MobileWebCreationSshStateResult = z.infer<typeof MobileWebCreationSshStateResultSchema>
export type MobileWebCreationRepoHooksResult = z.infer<
  typeof MobileWebCreationRepoHooksResultSchema
>
export type MobileWebCreationPersistTrustPayload = z.infer<
  typeof MobileWebCreationPersistTrustPayloadSchema
>
export type MobileWebCreationSparsePresetSavePayload = z.infer<
  typeof MobileWebCreationSparsePresetSavePayloadSchema
>
