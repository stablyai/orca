import { z } from 'zod'

// Why snake_case: these mirror the provider CLI's --json wire exactly, so no mapping layer can drift.

function isOneOf<T extends string>(values: readonly T[], value: string): value is T {
  return values.some((candidate) => candidate === value)
}

/** Unknown future enum arms degrade to 'unknown' so a newer provider never breaks the picker. */
function lenientEnum<const T extends string>(values: readonly T[]) {
  return z
    .string()
    .transform((value): T | 'unknown' => (isOneOf(values, value) ? value : 'unknown'))
}

const Timestamp = z.string()
const Count = z.number().int().nonnegative()

export const CC_SYNC_PAUSE_REASONS = [
  'cellular',
  'expensive',
  'constrained',
  'unknown-network',
  'disconnected',
  'manual-metered',
  'peer-offline',
  'restricted-mid-transfer'
] as const

export const CC_SYNC_ERROR_CODES = [
  'not-ready',
  'live-local-collision',
  'divergent-local-copy',
  'incompatible',
  'orca-not-local',
  'orca-unavailable',
  'checkout-conflict',
  'cancelled',
  'not-found',
  'unsupported'
] as const

export const CC_SYNC_PICKUP_PHASES = [
  'select',
  'restore-code',
  'restore-sessions',
  'orca-import',
  'orca-resume'
] as const

const PauseSchema = z.object({
  reason: lenientEnum(CC_SYNC_PAUSE_REASONS),
  endpoint: lenientEnum(['local', 'peer']),
  since: Timestamp
})

const HostSchema = z.object({ host_id: z.string(), host_name: z.string() })

const StatusSchema = z.object({
  version: z.literal(1),
  ok: z.literal(true),
  helper: z.object({ running: z.boolean(), build: z.string() }),
  local: HostSchema.extend({
    network: z.object({
      status: z.string(),
      expensive: z.boolean(),
      constrained: z.boolean(),
      cellular: z.boolean(),
      manual_metered: z.boolean()
    })
  }),
  peers: z.array(
    HostSchema.extend({
      reachable: z.boolean(),
      last_seen_at: Timestamp.nullable(),
      acked_revision: Count.nullable(),
      pending_revision: Count.nullable(),
      pending_since: Timestamp.nullable(),
      pause: PauseSchema.nullable()
    })
  ),
  scheduler: z.object({
    queued_by_tier: z.object({ human: Count, autonomous: Count, recent: Count, idle: Count }),
    workers: Count,
    last_round_at: Timestamp.nullable()
  })
})

const CheckpointTier = lenientEnum(['latest', 'hourly', 'daily'])

const ItemSchema = z.object({
  selector: z.string().min(1),
  source: HostSchema.extend({ last_seen_at: Timestamp.nullable(), reachable: z.boolean() }),
  workspace: z.object({
    id: z.string(),
    repo_name: z.string(),
    repo_origin: z.string().nullable(),
    branch: z.string().nullable(),
    source_path: z.string(),
    orca: z
      .object({
        kind: lenientEnum(['worktree', 'folder']),
        name: z.string(),
        instance_id: z.string()
      })
      .nullable()
  }),
  sessions: z.array(
    z.object({
      session_id: z.string().min(1),
      title: z.string(),
      last_activity_at: Timestamp.nullable(),
      last_human_activity_at: Timestamp.nullable(),
      activity: lenientEnum(['human', 'autonomous', 'idle']),
      bound_in_orca: z.boolean(),
      live_local_collision: z.boolean()
    })
  ),
  not_restorable: z.array(
    z.object({ agent: z.string(), key: z.string(), id: z.string(), reason: z.string() })
  ),
  checkpoint: z.object({
    id: z.string(),
    tier: CheckpointTier,
    captured_at: Timestamp,
    source_activity_at: Timestamp.nullable()
  }),
  checkpoint_count: Count,
  completeness: z.object({
    ready: z.boolean(),
    missing: z.array(z.string()),
    transcript: lenientEnum(['complete', 'partial', 'missing']),
    code: lenientEnum(['complete', 'deferred', 'missing', 'none']),
    layout: lenientEnum(['client-view', 'host-only', 'none']),
    code_captured_at: Timestamp.nullable().optional()
  }),
  newer_partial: z
    .object({
      id: z.string(),
      captured_at: Timestamp,
      session_activity_at: Timestamp.nullable(),
      code_captured_at: Timestamp.nullable()
    })
    .nullable(),
  pause: PauseSchema.nullable(),
  local_checkout: z.object({ path: z.string(), reusable: z.boolean() }).nullable()
})

const ListSchema = z.object({
  version: z.literal(1),
  ok: z.literal(true),
  generated_at: Timestamp,
  local: HostSchema,
  items: z.array(ItemSchema)
})

const InspectSchema = ItemSchema.extend({
  version: z.literal(1),
  ok: z.literal(true),
  checkpoints: z.array(
    z.object({
      id: z.string(),
      tier: CheckpointTier,
      captured_at: Timestamp,
      ready: z.boolean(),
      missing: z.array(z.string()),
      deferred: z.array(z.string())
    })
  ),
  delivery: z.array(
    z.object({ peer: z.string(), state: z.string(), pause: PauseSchema.nullable() })
  )
})

const PickupSchema = z.object({
  version: z.literal(1),
  ok: z.literal(true),
  checkout: z.object({ path: z.string(), branch: z.string().nullable(), reused: z.boolean() }),
  sessions: z.array(
    z.object({
      session_id: z.string(),
      status: lenientEnum(['resumed', 'dormant', 'restored', 'refused']),
      reason: z.string().optional()
    })
  ),
  orca: z
    .object({
      execution_host_id: z.literal('local'),
      worktree_id: z.string(),
      resumed: z.array(z.object({ session_id: z.string(), tab_id: z.string() })),
      dormant: z.array(z.string())
    })
    .nullable()
})

const DivergenceDetailsSchema = z.object({
  session_id: z.string(),
  local_last_activity_at: Timestamp.nullable(),
  picked_captured_at: Timestamp
})

const FailureSchema = z.object({
  version: z.literal(1),
  ok: z.literal(false),
  error: z.object({
    code: lenientEnum(CC_SYNC_ERROR_CODES),
    message: z.string(),
    // Why catch: only divergent-local-copy defines details; another shape must not void the failure.
    details: DivergenceDetailsSchema.optional().catch(undefined)
  })
})

const ProgressSchema = z.object({
  phase: lenientEnum(CC_SYNC_PICKUP_PHASES),
  done: Count.optional(),
  total: Count.optional()
})

export type CcSyncPause = z.infer<typeof PauseSchema>
export type CcSyncStatus = z.infer<typeof StatusSchema>
export type CcSyncItem = z.infer<typeof ItemSchema>
export type CcSyncList = z.infer<typeof ListSchema>
export type CcSyncInspect = z.infer<typeof InspectSchema>
export type CcSyncPickup = z.infer<typeof PickupSchema>
export type CcSyncFailure = z.infer<typeof FailureSchema>
export type CcSyncErrorCode = CcSyncFailure['error']['code']
export type CcSyncProgress = z.infer<typeof ProgressSchema>

export type CcSyncParseResult<T> =
  | { kind: 'success'; value: T }
  | { kind: 'failure'; error: CcSyncFailure['error'] }
  | { kind: 'invalid'; message: string }

function parseEnvelope<T>(schema: z.ZodType<T>, raw: unknown): CcSyncParseResult<T> {
  const failure = FailureSchema.safeParse(raw)
  if (failure.success) {
    return { kind: 'failure', error: failure.data.error }
  }
  const parsed = schema.safeParse(raw)
  if (parsed.success) {
    return { kind: 'success', value: parsed.data }
  }
  return { kind: 'invalid', message: z.prettifyError(parsed.error) }
}

export function parseCcSyncStatus(raw: unknown): CcSyncParseResult<CcSyncStatus> {
  return parseEnvelope(StatusSchema, raw)
}

export function parseCcSyncList(raw: unknown): CcSyncParseResult<CcSyncList> {
  return parseEnvelope(ListSchema, raw)
}

export function parseCcSyncInspect(raw: unknown): CcSyncParseResult<CcSyncInspect> {
  return parseEnvelope(InspectSchema, raw)
}

export function parseCcSyncPickup(raw: unknown): CcSyncParseResult<CcSyncPickup> {
  return parseEnvelope(PickupSchema, raw)
}

/** One `--progress ndjson` stderr line; anything else on stderr is diagnostics, not progress. */
export function parseCcSyncProgressLine(line: string): CcSyncProgress | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  const parsed = ProgressSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
