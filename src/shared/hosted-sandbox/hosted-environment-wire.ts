// Wire contract for org environments and their builds (cloud/apps/sandbox-control/src/environment-routes.ts).
// Objects are loose so the control plane can add fields without breaking older desktops; the fields
// the desktop reads are still type-checked.
import { z } from 'zod'
import { HOSTED_SANDBOX_MACHINE_SIZES } from './hosted-sandbox-wire'

export const HOSTED_ENVIRONMENT_ID = /^env_[0-9a-f]{8,40}$/
export const HOSTED_ENVIRONMENT_BUILD_ID = /^bld_[0-9a-f]{8,40}$/
export const HOSTED_ENVIRONMENT_ENV_VAR_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/
export const HOSTED_ENVIRONMENT_MAX_INSTALL_SCRIPT_CHARS = 20_000
export const HOSTED_ENVIRONMENT_MAX_ENV_VAR_NAMES = 100
export const HOSTED_ENVIRONMENT_MAX_REPOS = 50
export const HOSTED_ENVIRONMENT_MAX_NAME_CHARS = 80

export const HOSTED_ENVIRONMENT_BUILD_STATUSES = [
  'starting',
  'running',
  'snapshotting',
  'succeeded',
  'failed',
  'canceled'
] as const
export type HostedEnvironmentBuildStatus = (typeof HOSTED_ENVIRONMENT_BUILD_STATUSES)[number]

export const HOSTED_ENVIRONMENT_TERMINAL_BUILD_STATUSES: ReadonlySet<HostedEnvironmentBuildStatus> =
  new Set(['succeeded', 'failed', 'canceled'])

export function isTerminalHostedEnvironmentBuildStatus(
  status: HostedEnvironmentBuildStatus
): boolean {
  return HOSTED_ENVIRONMENT_TERMINAL_BUILD_STATUSES.has(status)
}

export const HOSTED_ENVIRONMENT_BUILD_STEPS = [
  'boot',
  'clone',
  'install',
  'record',
  'snapshot'
] as const
export type HostedEnvironmentBuildStep = (typeof HOSTED_ENVIRONMENT_BUILD_STEPS)[number]

export const HOSTED_ENVIRONMENT_STALENESS_RECOMMENDATIONS = [
  'no_build',
  'deps_changed',
  'config_changed',
  'branch_moved',
  'up_to_date',
  'image_updated',
  'unknown'
] as const
export type HostedEnvironmentStalenessRecommendation =
  (typeof HOSTED_ENVIRONMENT_STALENESS_RECOMMENDATIONS)[number]

const Millis = z.number().int().nonnegative()
const Actor = z.string().max(256)
const EnvironmentId = z.string().regex(HOSTED_ENVIRONMENT_ID)
const BuildId = z.string().regex(HOSTED_ENVIRONMENT_BUILD_ID)
const RepoUrl = z.string().min(1).max(2048)
const Branch = z.string().max(255)
const MachineSize = z.enum(HOSTED_SANDBOX_MACHINE_SIZES)

export const HostedEnvironmentRepoSchema = z.looseObject({
  url: RepoUrl,
  defaultBranch: Branch.nullable()
})

export const HostedEnvironmentViewSchema = z.looseObject({
  id: EnvironmentId,
  name: z.string().max(256),
  repos: z.array(HostedEnvironmentRepoSchema).max(HOSTED_ENVIRONMENT_MAX_REPOS),
  installScript: z.string().max(HOSTED_ENVIRONMENT_MAX_INSTALL_SCRIPT_CHARS),
  envVarNames: z.array(z.string().max(128)).max(HOSTED_ENVIRONMENT_MAX_ENV_VAR_NAMES),
  machineSize: MachineSize,
  activeBuildId: BuildId.nullable(),
  revision: z.number().int().nonnegative(),
  createdBy: Actor,
  updatedBy: Actor,
  createdAt: Millis,
  updatedAt: Millis
})
export type HostedEnvironmentView = z.infer<typeof HostedEnvironmentViewSchema>

export const HostedEnvironmentBuildRepoSchema = z.looseObject({
  url: RepoUrl,
  branch: Branch.nullable(),
  commit: z.string().max(64).nullable()
})

export const HostedEnvironmentBuildViewSchema = z.looseObject({
  id: BuildId,
  number: z.number().int().positive(),
  status: z.enum(HOSTED_ENVIRONMENT_BUILD_STATUSES),
  active: z.boolean(),
  createdBy: Actor,
  createdAt: Millis,
  startedAt: Millis.nullable(),
  snapshotStartedAt: Millis.nullable(),
  finishedAt: Millis.nullable(),
  durationMs: z.number().int().nullable(),
  activatable: z.boolean(),
  // Open set ('exit_N', 'provider_NNN', ...): shown, never switched on exhaustively.
  error: z.string().max(256).nullable(),
  // A step a newer control plane adds reads as "unknown step" rather than failing the whole list.
  failedStep: z.enum(HOSTED_ENVIRONMENT_BUILD_STEPS).nullable().catch(null),
  revision: z.number().int().nonnegative(),
  machineSize: MachineSize,
  repos: z.array(HostedEnvironmentBuildRepoSchema).max(HOSTED_ENVIRONMENT_MAX_REPOS),
  diskUsedBytes: z.number().nonnegative().nullable(),
  diskTotalBytes: z.number().nonnegative().nullable(),
  logBytes: z.number().int().nonnegative(),
  logTruncated: z.boolean()
})
export type HostedEnvironmentBuildView = z.infer<typeof HostedEnvironmentBuildViewSchema>

export const HostedEnvironmentListEntrySchema = HostedEnvironmentViewSchema.extend({
  activeBuild: HostedEnvironmentBuildViewSchema.nullable(),
  latestBuild: HostedEnvironmentBuildViewSchema.nullable()
})
export type HostedEnvironmentListEntry = z.infer<typeof HostedEnvironmentListEntrySchema>

export const HostedEnvironmentListResponseSchema = z.looseObject({
  environments: z.array(HostedEnvironmentListEntrySchema).max(1000),
  canAdmin: z.boolean()
})
export type HostedEnvironmentListResponse = z.infer<typeof HostedEnvironmentListResponseSchema>

export const HostedEnvironmentDetailResponseSchema = z.looseObject({
  environment: HostedEnvironmentViewSchema,
  builds: z.array(HostedEnvironmentBuildViewSchema).max(1000),
  canAdmin: z.boolean()
})
export type HostedEnvironmentDetailResponse = z.infer<typeof HostedEnvironmentDetailResponseSchema>

export const HostedEnvironmentResponseSchema = z.looseObject({
  environment: HostedEnvironmentViewSchema
})

export const HostedEnvironmentBuildResponseSchema = z.looseObject({
  build: HostedEnvironmentBuildViewSchema
})

export const HostedEnvironmentDeletedResponseSchema = z.looseObject({
  deleted: z.literal(true)
})

export const HostedEnvironmentRepoStalenessSchema = z.looseObject({
  url: RepoUrl,
  branch: Branch.nullable(),
  builtCommit: z.string().max(64).nullable(),
  headCommit: z.string().max(64).nullable(),
  aheadBy: z.number().int().nullable(),
  lockfilesChanged: z.array(z.string().max(512)).max(200),
  error: z.string().max(512).nullable()
})

export const HostedEnvironmentStalenessSchema = z.looseObject({
  checkedAt: Millis,
  activeBuildId: BuildId.nullable(),
  configChanged: z.boolean(),
  /** The golden image moved since the active build. Older control planes omit it. */
  imageUpdated: z.boolean().optional(),
  recommendation: z.enum(HOSTED_ENVIRONMENT_STALENESS_RECOMMENDATIONS).catch('unknown'),
  repos: z.array(HostedEnvironmentRepoStalenessSchema).max(HOSTED_ENVIRONMENT_MAX_REPOS)
})
export type HostedEnvironmentStaleness = z.infer<typeof HostedEnvironmentStalenessSchema>

export const HostedEnvironmentStalenessResponseSchema = z.looseObject({
  staleness: HostedEnvironmentStalenessSchema
})

export const HostedEnvironmentErrorResponseSchema = z.looseObject({
  error: z.string().min(1).max(64),
  reason: z.string().max(128).optional()
})

// --- Requests -------------------------------------------------------------------------------

const RepoInputSchema = z
  .object({
    url: z.string().trim().min(1).max(2048),
    defaultBranch: z.string().min(1).max(255).nullable().optional()
  })
  .strict()

const EnvVarNamesSchema = z
  .array(z.string().regex(HOSTED_ENVIRONMENT_ENV_VAR_NAME))
  .max(HOSTED_ENVIRONMENT_MAX_ENV_VAR_NAMES)

export const HostedEnvironmentCreateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(HOSTED_ENVIRONMENT_MAX_NAME_CHARS),
    repos: z.array(RepoInputSchema).max(HOSTED_ENVIRONMENT_MAX_REPOS),
    installScript: z.string().max(HOSTED_ENVIRONMENT_MAX_INSTALL_SCRIPT_CHARS).optional(),
    envVarNames: EnvVarNamesSchema.optional(),
    machineSize: MachineSize.optional()
  })
  .strict()
export type HostedEnvironmentCreateInput = z.infer<typeof HostedEnvironmentCreateInputSchema>

export const HostedEnvironmentUpdateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(HOSTED_ENVIRONMENT_MAX_NAME_CHARS).optional(),
    repos: z.array(RepoInputSchema).max(HOSTED_ENVIRONMENT_MAX_REPOS).optional(),
    installScript: z.string().max(HOSTED_ENVIRONMENT_MAX_INSTALL_SCRIPT_CHARS).optional(),
    envVarNames: EnvVarNamesSchema.optional(),
    machineSize: MachineSize.optional(),
    /** Optimistic concurrency: the control plane refuses with stale_revision when someone saved since. */
    expectedRevision: z.number().int().positive().optional()
  })
  .strict()
export type HostedEnvironmentUpdateInput = z.infer<typeof HostedEnvironmentUpdateInputSchema>

// --- Build event stream (application/x-ndjson, one object per line) --------------------------

export const HostedEnvironmentBuildStreamLineSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('build'), build: HostedEnvironmentBuildViewSchema }),
  z.looseObject({
    type: z.literal('log'),
    stream: z.enum(['stdout', 'stderr']),
    data: z.string(),
    at: Millis.optional()
  }),
  z.looseObject({ type: z.literal('end') }),
  // Liveness only (every ~20 s while a build is quiet); never forwarded to the renderer.
  z.looseObject({ type: z.literal('heartbeat'), at: Millis.optional() }),
  z.looseObject({ type: z.literal('error'), error: z.string().max(128).optional() })
])
export type HostedEnvironmentBuildStreamLine = z.infer<
  typeof HostedEnvironmentBuildStreamLineSchema
>

export function isHostedEnvironmentId(value: unknown): value is string {
  return typeof value === 'string' && HOSTED_ENVIRONMENT_ID.test(value)
}

export function isHostedEnvironmentBuildId(value: unknown): value is string {
  return typeof value === 'string' && HOSTED_ENVIRONMENT_BUILD_ID.test(value)
}
