// Orca Cloud programmatic access (API keys, org settings, audit, routines): the control plane's
// /v1 wire shapes, validated in main before anything reaches the renderer. Shared by main + renderer.
import { z } from 'zod'

export const CLOUD_API_SCOPES = [
  'workspaces:read',
  'workspaces:write',
  'messages:write',
  'projects:read',
  'projects:write',
  'routines:read',
  'routines:write',
  'audit:read'
] as const
export type CloudApiScope = (typeof CLOUD_API_SCOPES)[number]

/** Scopes only an org owner/admin may grant (personal accounts are their own admin). */
export const CLOUD_API_ADMIN_SCOPES: readonly CloudApiScope[] = ['audit:read']
export const CLOUD_API_READ_SCOPES: readonly CloudApiScope[] = [
  'workspaces:read',
  'projects:read',
  'routines:read'
]

const Id = z.string().min(1).max(128)
const Millis = z.number().int().nonnegative()
const ShortText = z.string().max(500)
// Unknown scopes from a newer server are dropped rather than failing the whole list.
const Scopes = z
  .array(z.string().max(64))
  .max(64)
  .transform((scopes) =>
    scopes.filter((scope): scope is CloudApiScope =>
      (CLOUD_API_SCOPES as readonly string[]).includes(scope)
    )
  )

export const CloudApiMeSchema = z.object({
  accountId: Id,
  userId: Id,
  orgId: Id.nullable(),
  role: z.enum(['owner', 'admin', 'member']),
  scopes: Scopes
})
export type CloudApiMe = z.infer<typeof CloudApiMeSchema>

export const CloudApiKeySchema = z.object({
  id: Id,
  name: z.string().max(200),
  prefix: z.string().max(64),
  scopes: Scopes,
  createdBy: Id,
  createdAt: Millis,
  lastUsedAt: Millis.nullable(),
  expiresAt: Millis.nullable()
})
export type CloudApiKey = z.infer<typeof CloudApiKeySchema>

export const CloudApiKeyListSchema = z.object({
  keys: z.array(CloudApiKeySchema).max(500),
  availableScopes: Scopes
})
export type CloudApiKeyList = z.infer<typeof CloudApiKeyListSchema>

export const CloudApiCreatedKeySchema = z.object({
  key: CloudApiKeySchema,
  secret: z.string().regex(/^orca_[a-z]+_[A-Za-z0-9]{16,128}$/)
})
export type CloudApiCreatedKey = z.infer<typeof CloudApiCreatedKeySchema>

/** One-time code (10 min, single use) the user pastes on the MCP consent page to approve an app. */
export const CloudApiApprovalSchema = z.object({
  code: z.string().regex(/^orca_ap_[A-Za-z0-9]{16,128}$/),
  expiresAt: Millis,
  scopes: Scopes
})
export type CloudApiApproval = z.infer<typeof CloudApiApprovalSchema>

export const CreateCloudApiApprovalInputSchema = z
  .object({
    scopes: z.array(z.enum(CLOUD_API_SCOPES)).min(1).max(CLOUD_API_SCOPES.length).optional()
  })
  .strict()
export type CreateCloudApiApprovalInput = z.infer<typeof CreateCloudApiApprovalInputSchema>

export const CloudApiSettingsSchema = z.object({
  settings: z.object({ vmCliEnabled: z.boolean() }),
  canEdit: z.boolean()
})
export type CloudApiSettings = z.infer<typeof CloudApiSettingsSchema>

export const CloudApiAuditEntrySchema = z.object({
  id: Id,
  actor: z.object({
    type: z.string().max(64),
    id: z.string().max(128),
    userId: z.string().max(128).nullable()
  }),
  action: z.string().max(128),
  target: z.object({ type: z.string().max(64), id: z.string().max(128).nullable() }).nullable(),
  createdAt: Millis
})
export type CloudApiAuditEntry = z.infer<typeof CloudApiAuditEntrySchema>

export const CloudApiAuditPageSchema = z.object({
  entries: z.array(CloudApiAuditEntrySchema).max(500),
  nextBefore: Millis.nullable()
})
export type CloudApiAuditPage = z.infer<typeof CloudApiAuditPageSchema>

export const CloudApiProjectSchema = z.object({
  id: Id,
  name: z.string().max(200),
  repo: z.object({ url: z.string().max(2048), ref: z.string().max(255).nullable() }).nullable()
})
export type CloudApiProject = z.infer<typeof CloudApiProjectSchema>

export const CloudApiProjectListSchema = z.object({
  projects: z.array(CloudApiProjectSchema).max(1000)
})

export const CloudApiInstallationSchema = z.object({
  installationId: z.union([z.number(), z.string()]).transform(String),
  account: z.string().max(200),
  accountType: z.string().max(64).nullable().optional()
})
export type CloudApiInstallation = z.infer<typeof CloudApiInstallationSchema>

export const CloudApiInstallationListSchema = z.object({
  installations: z.array(CloudApiInstallationSchema).max(500)
})

// ── Routines ────────────────────────────────────────────────────────────────

export const ROUTINE_GITHUB_EVENTS = [
  'pull_request.opened',
  'pull_request.labeled',
  'pull_request.synchronize',
  'issues.opened',
  'issues.labeled',
  'issue_comment.created'
] as const
export type RoutineGithubEvent = (typeof ROUTINE_GITHUB_EVENTS)[number]

export const ROUTINE_AGENTS = ['claude', 'codex'] as const
export type RoutineAgent = (typeof ROUTINE_AGENTS)[number]
export const ROUTINE_POST_RESULTS = ['none', 'comment', 'pr'] as const
export type RoutinePostResults = (typeof ROUTINE_POST_RESULTS)[number]
export const ROUTINE_MACHINE_SIZES = ['standard', 'large'] as const
export type RoutineMachineSize = (typeof ROUTINE_MACHINE_SIZES)[number]

export const ROUTINE_RUN_STATUSES = [
  'queued',
  'starting',
  'running',
  'posting',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out'
] as const
export type RoutineRunStatus = (typeof ROUTINE_RUN_STATUSES)[number]
export const ROUTINE_RUN_TRIGGERS = ['schedule', 'github', 'webhook', 'manual'] as const
export type RoutineRunTrigger = (typeof ROUTINE_RUN_TRIGGERS)[number]

const NameList = z.array(z.string().trim().min(1).max(100)).max(50)

const ScheduleTrigger = z.object({
  kind: z.literal('schedule'),
  cron: z.string().min(1).max(200),
  timezone: z.string().min(1).max(64)
})
const GithubTrigger = z.object({
  kind: z.literal('github'),
  events: z.array(z.enum(ROUTINE_GITHUB_EVENTS)).min(1).max(ROUTINE_GITHUB_EVENTS.length),
  labels: NameList.optional(),
  authors: NameList.optional(),
  baseBranches: NameList.optional()
})

/** What the editor sends. */
export const RoutineTriggerInputSchema = z.discriminatedUnion('kind', [
  ScheduleTrigger,
  GithubTrigger,
  z.object({ kind: z.literal('webhook') })
])
export type RoutineTriggerInput = z.infer<typeof RoutineTriggerInputSchema>

/** What the server returns: webhook triggers carry only a hint of the secret URL. */
export const RoutineTriggerSchema = z.discriminatedUnion('kind', [
  ScheduleTrigger,
  GithubTrigger.extend({ events: z.array(z.enum(ROUTINE_GITHUB_EVENTS)).max(20) }),
  z.object({ kind: z.literal('webhook'), urlHint: z.string().max(200).nullable().optional() })
])
export type RoutineTrigger = z.infer<typeof RoutineTriggerSchema>

const RepoRef = z.object({
  url: z.string().max(2048),
  ref: z.string().max(255).nullable().optional()
})

export const RoutineSchema = z.object({
  id: Id,
  name: z.string().max(200),
  projectId: Id.nullable(),
  repo: RepoRef.nullable(),
  enabled: z.boolean(),
  trigger: RoutineTriggerSchema,
  agent: z.enum(ROUTINE_AGENTS),
  prompt: z.string().max(20_000),
  postResults: z.enum(ROUTINE_POST_RESULTS),
  machineSize: z.string().max(32).nullable().optional(),
  maxRuntimeMinutes: z.number().int().positive().nullable().optional(),
  nextRunAt: Millis.nullable(),
  lastRun: z
    .object({ id: Id, status: z.enum(ROUTINE_RUN_STATUSES), finishedAt: Millis.nullable() })
    .nullable(),
  createdBy: Id,
  createdAt: Millis,
  updatedAt: Millis
})
export type Routine = z.infer<typeof RoutineSchema>

export const RoutineListSchema = z.object({ routines: z.array(RoutineSchema).max(1000) })
export const RoutineEnvelopeSchema = z.object({ routine: RoutineSchema })
export const RoutineCreatedSchema = z.object({
  routine: RoutineSchema,
  webhookUrl: z.url().max(2048).optional()
})
export type RoutineCreated = z.infer<typeof RoutineCreatedSchema>
export const RoutineWebhookSchema = z.object({ url: z.url().max(2048) })

export const RoutineRunSchema = z.object({
  id: Id,
  routineId: Id,
  trigger: z.enum(ROUTINE_RUN_TRIGGERS),
  triggerDetail: ShortText.nullable(),
  status: z.enum(ROUTINE_RUN_STATUSES),
  workspaceId: Id.nullable(),
  result: z
    .object({
      summary: z.string().max(4000).optional(),
      prUrl: z.url().max(2048).optional(),
      commentUrl: z.url().max(2048).optional()
    })
    .nullable(),
  error: z.string().max(2000).nullable(),
  createdAt: Millis,
  startedAt: Millis.nullable(),
  finishedAt: Millis.nullable(),
  durationMs: Millis.nullable()
})
export type RoutineRun = z.infer<typeof RoutineRunSchema>

export const RoutineRunEnvelopeSchema = z.object({ run: RoutineRunSchema })
export const RoutineRunPageSchema = z.object({
  runs: z.array(RoutineRunSchema).max(500),
  nextBefore: z.union([Millis, z.string().max(128)]).nullable()
})
export type RoutineRunPage = z.infer<typeof RoutineRunPageSchema>

// ── Renderer → main inputs (validated again in main) ────────────────────────

export const CreateCloudApiKeyInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    scopes: z.array(z.enum(CLOUD_API_SCOPES)).min(1).max(CLOUD_API_SCOPES.length),
    expiresInDays: z.number().int().min(1).max(365).optional()
  })
  .strict()
export type CreateCloudApiKeyInput = z.infer<typeof CreateCloudApiKeyInputSchema>

const RepoInput = z
  .object({
    url: z.url({ protocol: /^https$/ }).max(2048),
    ref: z.string().trim().min(1).max(255).optional()
  })
  .strict()

export const RoutineInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    projectId: Id.optional(),
    repo: RepoInput.optional(),
    trigger: RoutineTriggerInputSchema,
    agent: z.enum(ROUTINE_AGENTS),
    prompt: z.string().trim().min(1).max(20_000),
    postResults: z.enum(ROUTINE_POST_RESULTS),
    enabled: z.boolean().optional(),
    machineSize: z.enum(ROUTINE_MACHINE_SIZES).optional(),
    maxRuntimeMinutes: z.number().int().min(1).max(720).optional()
  })
  .strict()
export type RoutineInput = z.infer<typeof RoutineInputSchema>
export const RoutinePatchSchema = RoutineInputSchema.partial().strict()
export type RoutinePatch = z.infer<typeof RoutinePatchSchema>

export const RoutineRunsQuerySchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    before: z.union([Millis, z.string().max(128)]).optional()
  })
  .strict()
export type RoutineRunsQuery = z.infer<typeof RoutineRunsQuerySchema>

// ── Results ─────────────────────────────────────────────────────────────────

export const CLOUD_API_ERROR_CODES = [
  /** No control plane in this build. */
  'unconfigured',
  /** Not signed in to Orca, or the session expired. */
  'signed-out',
  /** Signed in, but this action needs an org owner/admin. */
  'admin-required',
  /** The key or token lacks a scope. */
  'forbidden',
  'not-found',
  /** The control plane does not offer this yet (older deployment). */
  'not-available',
  'invalid-request',
  'rate-limited',
  'network',
  'server',
  'invalid-response'
] as const
export type CloudApiErrorCode = (typeof CLOUD_API_ERROR_CODES)[number]

export type CloudApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: CloudApiErrorCode; detail?: string; retryAfterSeconds?: number }

export type CloudApiAvailability =
  | { status: 'unconfigured' }
  | { status: 'ready'; controlPlaneUrl: string }
