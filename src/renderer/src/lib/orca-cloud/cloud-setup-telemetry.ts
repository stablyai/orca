// N10: setup telemetry derived from the rows the tracker already renders, so every source (the
// setup session or rows derived from billing) reports the same way. Enum-only: no email, team,
// repository or session id leaves this file (see telemetry-cloud-setup-event-schemas).
import { track } from '@/diagnostics/telemetry/telemetry'
import type {
  CLOUD_SETUP_DURATION_BUCKETS,
  CLOUD_SETUP_HOURS_SOURCE_VALUES
} from '../../../../shared/telemetry-cloud-setup-event-schemas'
import type { CloudSetupErrorKind } from '@/components/new-workspace/cloud-setup/cloud-setup-errors'

type StepId = 'account' | 'team' | 'plan' | 'github' | 'agent'
/** Structural subset of the composer's CloudSetupStep; extra fields are ignored. */
export type CloudSetupTelemetryStep = { id: StepId; state: string }

export type CloudSetupTelemetryEvent =
  | { name: 'cloud_setup_step_started'; props: { step: StepId } }
  | {
      name: 'cloud_setup_step_done'
      props: { step: StepId; duration_bucket: (typeof CLOUD_SETUP_DURATION_BUCKETS)[number] }
    }
  | { name: 'cloud_setup_step_failed'; props: { step: StepId; error_kind: CloudSetupErrorKind } }
  | { name: 'cloud_setup_plan_chosen'; props: { after_trial: boolean } }

export type CloudSetupTelemetryState = {
  startedAt: number
  states: Partial<Record<StepId, string>>
  reportedErrors: ReadonlySet<CloudSetupErrorKind>
}

export function cloudSetupDurationBucket(
  ms: number
): (typeof CLOUD_SETUP_DURATION_BUCKETS)[number] {
  const seconds = Math.max(0, ms) / 1000
  if (seconds < 30) {
    return 'lt_30s'
  }
  if (seconds < 120) {
    return '30s_2m'
  }
  if (seconds < 300) {
    return '2m_5m'
  }
  return seconds < 900 ? '5m_15m' : 'gte_15m'
}

/**
 * Pure diff: which events one new snapshot of the rows produces. Rows already done the first time
 * a session is seen never count as "done" (they were finished before this trip). A failure is
 * charged to the row that was in the browser, else the first unfinished row.
 */
export function diffCloudSetupTelemetry(
  prev: CloudSetupTelemetryState | null,
  steps: readonly CloudSetupTelemetryStep[],
  error: CloudSetupErrorKind | null,
  now: number,
  { afterTrial = false }: { afterTrial?: boolean } = {}
): { events: CloudSetupTelemetryEvent[]; next: CloudSetupTelemetryState } {
  const startedAt = prev?.startedAt ?? now
  const events: CloudSetupTelemetryEvent[] = []
  const states: Partial<Record<StepId, string>> = {}
  for (const step of steps) {
    states[step.id] = step.state
    const before = prev?.states[step.id]
    if (before === step.state) {
      continue
    }
    if (step.state === 'active') {
      events.push({ name: 'cloud_setup_step_started', props: { step: step.id } })
    } else if (step.state === 'done' && before !== undefined) {
      events.push({
        name: 'cloud_setup_step_done',
        props: { step: step.id, duration_bucket: cloudSetupDurationBucket(now - startedAt) }
      })
      if (step.id === 'plan') {
        events.push({ name: 'cloud_setup_plan_chosen', props: { after_trial: afterTrial } })
      }
    }
  }
  const reportedErrors = new Set(prev?.reportedErrors ?? [])
  if (error && !reportedErrors.has(error)) {
    reportedErrors.add(error)
    const blamed =
      steps.find((step) => step.state === 'active' || step.state === 'failed') ??
      steps.find((step) => step.state !== 'done' && step.state !== 'optional')
    events.push({
      name: 'cloud_setup_step_failed',
      props: { step: blamed?.id ?? 'account', error_kind: error }
    })
  }
  return { events, next: { startedAt, states, reportedErrors } }
}

// Per setup session, for this renderer's lifetime. A restart starts a fresh baseline, which only
// drops "done" events for steps finished while Orca was closed.
const sessions = new Map<string, CloudSetupTelemetryState>()
const MAX_SESSIONS = 16

export function reportCloudSetupProgress(
  sessionId: string,
  steps: readonly CloudSetupTelemetryStep[],
  error: CloudSetupErrorKind | null,
  options: { afterTrial?: boolean; now?: number } = {}
): void {
  const { events, next } = diffCloudSetupTelemetry(
    sessions.get(sessionId) ?? null,
    steps,
    error,
    options.now ?? Date.now(),
    options
  )
  if (!sessions.has(sessionId) && sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value
    if (oldest !== undefined) {
      sessions.delete(oldest)
    }
  }
  sessions.set(sessionId, next)
  for (const event of events) {
    emit(event)
  }
}

function emit(event: CloudSetupTelemetryEvent): void {
  switch (event.name) {
    case 'cloud_setup_step_started':
      return track(event.name, event.props)
    case 'cloud_setup_step_done':
      return track(event.name, event.props)
    case 'cloud_setup_step_failed':
      return track(event.name, event.props)
    case 'cloud_setup_plan_chosen':
      return track(event.name, event.props)
  }
}

/** When the tracker first saw this session, for time to first sandbox. */
export function cloudSetupSessionStartedAt(sessionId: string): number | null {
  return sessions.get(sessionId)?.startedAt ?? null
}

/**
 * Time to first sandbox: call once when setup's auto-start submits the workspace (O4).
 * `sessionStartedAt` defaults to when the tracker first saw the session.
 */
export function recordCloudSetupFirstSandbox({
  sessionId,
  sessionStartedAt,
  hoursSource,
  now = Date.now()
}: {
  sessionId?: string
  sessionStartedAt?: number
  hoursSource: (typeof CLOUD_SETUP_HOURS_SOURCE_VALUES)[number]
  now?: number
}): void {
  const startedAt = sessionStartedAt ?? (sessionId ? cloudSetupSessionStartedAt(sessionId) : null)
  if (startedAt === null) {
    return
  }
  track('cloud_setup_first_sandbox', {
    duration_bucket: cloudSetupDurationBucket(now - startedAt),
    hours_source: hoursSource
  })
}

/** Test seam. */
export function resetCloudSetupTelemetry(): void {
  sessions.clear()
}
