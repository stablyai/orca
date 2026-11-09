// Orca Cloud routines: /v1/routines wire shapes and the editor's request bodies.
import { z } from 'zod'
import { HttpsUrl, Id, Millis, ShortText } from './cloud-api-primitives'

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
  webhookUrl: HttpsUrl.optional()
})
export type RoutineCreated = z.infer<typeof RoutineCreatedSchema>
export const RoutineWebhookSchema = z.object({ url: HttpsUrl })

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
      prUrl: HttpsUrl.optional(),
      commentUrl: HttpsUrl.optional()
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
/** Only changed fields; null clears a field (switching project ↔ repo, removing the time limit). */
export const RoutinePatchSchema = RoutineInputSchema.partial()
  .extend({
    projectId: Id.nullable().optional(),
    repo: RepoInput.nullable().optional(),
    maxRuntimeMinutes: z.number().int().min(1).max(720).nullable().optional()
  })
  .strict()
export type RoutinePatch = z.infer<typeof RoutinePatchSchema>

export const RoutineRunsQuerySchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    before: z.union([Millis, z.string().max(128)]).optional()
  })
  .strict()
export type RoutineRunsQuery = z.infer<typeof RoutineRunsQuerySchema>
