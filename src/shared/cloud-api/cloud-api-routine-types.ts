// Orca Cloud routines: the /v1/routines wire shapes the CLI reads.
import { z } from 'zod'
import { ORCA_CLOUD_IMAGE_AGENTS } from '../hosted-sandbox/orca-cloud-image-agents'
import { HttpsUrl, Id, Millis, PersonName } from './cloud-api-primitives'

// ── Routines ────────────────────────────────────────────────────────────────

export const ROUTINE_GITHUB_EVENTS = [
  'pull_request.opened',
  'pull_request.labeled',
  'pull_request.synchronize',
  'issues.opened',
  'issues.labeled',
  'issue_comment.created'
] as const

/** A routine runs any agent the Orca Cloud image ships, headless. */
export const ROUTINE_AGENTS = ORCA_CLOUD_IMAGE_AGENTS
export const ROUTINE_POST_RESULTS = ['none', 'comment', 'pr'] as const

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

/** What the server returns: webhook triggers carry only a hint of the secret URL. */
export const RoutineTriggerSchema = z.discriminatedUnion('kind', [
  ScheduleTrigger,
  GithubTrigger.extend({ events: z.array(z.enum(ROUTINE_GITHUB_EVENTS)).max(20) }),
  z.object({ kind: z.literal('webhook'), urlHint: z.string().max(200).nullable().optional() })
])

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
  createdByName: PersonName,
  createdAt: Millis,
  updatedAt: Millis
})
export type Routine = z.infer<typeof RoutineSchema>

const TriggerTarget = z.object({ repo: z.string().max(200), number: z.number().int() })
const TriggerDetailObject = z.object({
  event: z.string().max(100).optional(),
  target: TriggerTarget.optional().catch(undefined)
})

/** "acme/web#482 pull_request.labeled" for GitHub runs; null when there is nothing worth showing. */
export function triggerLabel(detail: unknown): string | null {
  if (typeof detail === 'string') {
    return detail.slice(0, 500) || null
  }
  const parsed = TriggerDetailObject.safeParse(detail)
  if (!parsed.success) {
    return null
  }
  const { event, target } = parsed.data
  const where = target ? `${target.repo}#${target.number}` : null
  return [where, event].filter(Boolean).join(' ') || null
}

export const RoutineRunSchema = z.object({
  id: Id,
  routineId: Id,
  trigger: z.enum(ROUTINE_RUN_TRIGGERS),
  // The control plane sends what fired the run as an object ({requestedBy} for manual runs,
  // {event, target} for GitHub, {scheduledFor} for schedules); the UI shows one short label.
  triggerDetail: z.unknown().transform(triggerLabel),
  status: z.enum(ROUTINE_RUN_STATUSES),
  workspaceId: Id.nullable(),
  result: z
    .object({
      summary: z.string().max(4000).optional(),
      // One bad link must not fail the whole runs page.
      prUrl: HttpsUrl.optional().catch(undefined),
      commentUrl: HttpsUrl.optional().catch(undefined)
    })
    .nullable(),
  error: z.string().max(2000).nullable(),
  createdAt: Millis,
  startedAt: Millis.nullable(),
  finishedAt: Millis.nullable(),
  durationMs: Millis.nullable()
})
export type RoutineRun = z.infer<typeof RoutineRunSchema>
