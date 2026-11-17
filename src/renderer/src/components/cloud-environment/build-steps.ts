import { formatElapsedTime } from '../worktree-creation/worktree-creation-clock'
import type { EnvironmentBuildStep, EnvironmentBuildView } from './cloud-environment-types'
import { BUILD_STEPS, type StepMarker } from './build-log-model'

export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'skipped'

export type BuildStepView = {
  id: EnvironmentBuildStep
  status: StepStatus
  startedAt: number | null
  endedAt: number | null
  /** Elapsed time; ticks against `now` while running. Null when the step has no timing. */
  durationMs: number | null
}

function reachedStep(
  build: EnvironmentBuildView,
  markers: Partial<Record<EnvironmentBuildStep, StepMarker>>
): EnvironmentBuildStep {
  if (build.failedStep) {
    return build.failedStep
  }
  if (build.status === 'snapshotting' || build.snapshotStartedAt !== null) {
    return 'snapshot'
  }
  if (build.status === 'starting' || build.startedAt === null) {
    return 'boot'
  }
  for (const step of ['record', 'install', 'clone'] as const) {
    if (markers[step]) {
      return step
    }
  }
  return 'clone'
}

/**
 * Turn the build view + log markers into the five-step timeline: boot = createdAt..startedAt,
 * script steps from `::orca-step::` markers, snapshot = snapshotStartedAt..finishedAt.
 */
export function deriveBuildSteps(
  build: EnvironmentBuildView,
  markers: Partial<Record<EnvironmentBuildStep, StepMarker>>,
  now: number
): BuildStepView[] {
  const reached = reachedStep(build, markers)
  const reachedIndex = BUILD_STEPS.indexOf(reached)
  const terminal =
    build.status === 'succeeded' || build.status === 'failed' || build.status === 'canceled'
  const end = build.finishedAt ?? (terminal ? (build.snapshotStartedAt ?? build.startedAt) : null)

  const starts: Record<EnvironmentBuildStep, number | null> = {
    boot: build.createdAt,
    clone: markers.clone?.at ?? build.startedAt,
    install: markers.install?.at ?? null,
    record: markers.record?.at ?? null,
    snapshot: build.snapshotStartedAt
  }
  const scriptEnd = build.snapshotStartedAt ?? end
  const ends: Record<EnvironmentBuildStep, number | null> = {
    boot: build.startedAt ?? (terminal ? end : null),
    clone: starts.install ?? starts.record ?? scriptEnd,
    install: starts.record ?? scriptEnd,
    record: scriptEnd,
    snapshot: build.finishedAt
  }

  return BUILD_STEPS.map((id, index): BuildStepView => {
    let status: StepStatus
    if (build.status === 'succeeded') {
      status = 'succeeded'
    } else if (index < reachedIndex) {
      status = 'succeeded'
    } else if (index > reachedIndex) {
      status = terminal ? 'skipped' : 'pending'
    } else if (build.status === 'failed') {
      status = 'failed'
    } else if (build.status === 'canceled') {
      status = 'canceled'
    } else {
      status = 'running'
    }
    const startedAt = status === 'pending' || status === 'skipped' ? null : starts[id]
    let endedAt = status === 'running' ? null : ends[id]
    if (status === 'pending' || status === 'skipped') {
      endedAt = null
    }
    const stop = status === 'running' ? now : endedAt
    const durationMs = startedAt !== null && stop !== null ? Math.max(0, stop - startedAt) : null
    return { id, status, startedAt, endedAt, durationMs }
  })
}

/** The step to auto-expand: the failing one, else the running one, else none. */
export function focusStep(steps: readonly BuildStepView[]): EnvironmentBuildStep | null {
  return (
    steps.find((step) => step.status === 'failed')?.id ??
    steps.find((step) => step.status === 'running')?.id ??
    steps.find((step) => step.status === 'canceled')?.id ??
    null
  )
}

/** Shared elapsed-time format ("1m 42s"); empty when the step has no timing. */
export function formatStepDuration(ms: number | null): string {
  return ms === null ? '' : formatElapsedTime(ms)
}

export function formatLineTimestamp(at: number | null, origin: number | null): string {
  if (at === null) {
    return ''
  }
  if (origin !== null) {
    const elapsed = Math.max(0, at - origin)
    const minutes = Math.floor(elapsed / 60000)
    const seconds = ((elapsed % 60000) / 1000).toFixed(1).padStart(4, '0')
    return `${minutes.toString().padStart(2, '0')}:${seconds}`
  }
  return new Date(at).toISOString().slice(11, 19)
}
