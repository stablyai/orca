import { ChevronDown, EyeOff, Maximize2 } from 'lucide-react'
import type { ReactNode } from 'react'
import type {
  MaestroRunProgress,
  MaestroRunProgressReference,
  MaestroRunProgressV2
} from '../../../../shared/maestro-run-progress'
import { legacyMaestroTaskProgress } from '../../../../shared/maestro-run-progress'
import type { MaestroRunResource } from '../../../../shared/maestro-run-resource'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { RunProgressSection, type MaestroRunProgressRow } from './MaestroRunProgressSections'

export type MaestroRunProgressPresentation = MaestroRunProgress | MaestroRunProgressV2

export const V2_STATE_LABELS: Record<MaestroRunProgressV2['execution']['state'], () => string> = {
  active: () =>
    translate('auto.components.maestro.MaestroWorkspaceHarnessOverlay.stateActive', 'Running'),
  input_required: () =>
    translate(
      'auto.components.maestro.MaestroWorkspaceHarnessOverlay.stateInputRequired',
      'Input required'
    ),
  blocked: () =>
    translate('auto.components.maestro.MaestroWorkspaceHarnessOverlay.stateBlocked', 'Blocked'),
  completed: () =>
    translate('auto.components.maestro.MaestroWorkspaceHarnessOverlay.stateCompleted', 'Completed'),
  completed_with_failures: () =>
    translate(
      'auto.components.maestro.MaestroWorkspaceHarnessOverlay.stateCompletedWithFailures',
      'Completed with failures'
    ),
  cancelled: () =>
    translate('auto.components.maestro.MaestroWorkspaceHarnessOverlay.stateCancelled', 'Cancelled'),
  outcome_unknown: () =>
    translate(
      'auto.components.maestro.MaestroWorkspaceHarnessOverlay.stateOutcomeUnknown',
      'Outcome unknown'
    )
}

export function isMaestroRunProgressV2(
  progress: MaestroRunProgressPresentation
): progress is MaestroRunProgressV2 {
  return 'schema_version' in progress && progress.schema_version === 2
}

export function availableLegacyRunProgress(
  progress: MaestroRunProgressPresentation
): Extract<MaestroRunProgress, { available: true }> | null {
  return 'available' in progress && progress.available ? progress : null
}

export function legacyStateLabel(
  progress: Extract<MaestroRunProgress, { available: true }>
): string {
  const taskProgress = legacyMaestroTaskProgress(progress.summary)
  if (taskProgress.allSettled) {
    return taskProgress.hasFailures
      ? translate(
          'auto.components.maestro.MaestroWorkspaceHarnessOverlay.stateCompletedWithFailures',
          'Completed with failures'
        )
      : translate(
          'auto.components.maestro.MaestroWorkspaceHarnessOverlay.stateCompleted',
          'Completed'
        )
  }
  const state = progress.summary.state
  const labels: Record<typeof state, string> = {
    active: translate(
      'auto.components.maestro.MaestroWorkspaceHarnessOverlay.stateActive',
      'Running'
    ),
    input_required: translate(
      'auto.components.maestro.MaestroWorkspaceHarnessOverlay.stateInputRequired',
      'Input required'
    ),
    blocked: translate(
      'auto.components.maestro.MaestroWorkspaceHarnessOverlay.stateBlocked',
      'Blocked'
    ),
    partial: translate(
      'auto.components.maestro.MaestroWorkspaceHarnessOverlay.stateInProgress',
      'In progress'
    ),
    complete: translate(
      'auto.components.maestro.MaestroWorkspaceHarnessOverlay.stateCompleted',
      'Completed'
    ),
    failed: translate(
      'auto.components.maestro.MaestroWorkspaceHarnessOverlay.stateFailed',
      'Failed'
    ),
    outcome_unknown: translate(
      'auto.components.maestro.MaestroWorkspaceHarnessOverlay.stateOutcomeUnknown',
      'Outcome unknown'
    )
  }
  return labels[state]
}

export function humanProgressRows(progress: MaestroRunProgressV2): {
  current: MaestroRunProgressRow[]
  recent: MaestroRunProgressRow[]
  blocked: MaestroRunProgressRow[]
  next: MaestroRunProgressRow[]
  nested: MaestroRunProgressRow[]
} {
  return {
    current: progress.current.map((entry) => ({
      key: `current:${entry.reference}`,
      reference: entry.reference,
      title: entry.title,
      workerLabel: entry.worker_label,
      detail: entry.activity_summary,
      state: entry.state
    })),
    recent: progress.recently_completed.map((entry) => ({
      key: `recent:${entry.reference}`,
      reference: entry.reference,
      title: entry.title,
      workerLabel: entry.worker_label,
      detail: entry.outcome_summary,
      state: 'completed'
    })),
    blocked: progress.blocked.map((entry) => ({
      key: `blocked:${entry.reference}`,
      reference: entry.reference,
      title: entry.title,
      workerLabel: entry.worker_label,
      detail: entry.blocker_summary,
      state: 'blocked'
    })),
    next: progress.next.map((entry) => ({
      key: `next:${entry.reference}`,
      reference: entry.reference,
      title: entry.title,
      workerLabel: entry.worker_label,
      detail: entry.next_step,
      state: 'pending'
    })),
    nested: progress.nested_activity.map((entry) => ({
      key: `nested:${entry.child_id}`,
      reference: entry.parent_reference,
      title: entry.label,
      detail:
        entry.activity_summary ??
        translate(
          'auto.components.maestro.MaestroWorkspaceHarnessOverlay.nativeChildActivity',
          'Native child activity'
        ),
      state: entry.state,
      meta: entry.model
    }))
  }
}

const RESOURCE_KIND_LABELS: Record<
  NonNullable<MaestroRunProgressV2['resources']>[number]['kind'],
  () => string
> = {
  coordinator: () =>
    translate(
      'auto.components.maestro.MaestroWorkspaceHarnessOverlay.resourceCoordinator',
      'Coordinator'
    ),
  task: () =>
    translate('auto.components.maestro.MaestroWorkspaceHarnessOverlay.resourceTask', 'Task'),
  attempt: () =>
    translate('auto.components.maestro.MaestroWorkspaceHarnessOverlay.resourceAttempt', 'Attempt'),
  dispatch: () =>
    translate(
      'auto.components.maestro.MaestroWorkspaceHarnessOverlay.resourceDispatch',
      'Dispatch'
    ),
  provider: () =>
    translate(
      'auto.components.maestro.MaestroWorkspaceHarnessOverlay.resourceProvider',
      'Provider'
    ),
  terminal: () =>
    translate(
      'auto.components.maestro.MaestroWorkspaceHarnessOverlay.resourceTerminal',
      'Terminal'
    ),
  browser: () =>
    translate('auto.components.maestro.MaestroWorkspaceHarnessOverlay.resourceBrowser', 'Browser'),
  cleanup: () =>
    translate('auto.components.maestro.MaestroWorkspaceHarnessOverlay.resourceCleanup', 'Cleanup')
}

const RESOURCE_STATE_LABELS: Record<
  NonNullable<MaestroRunProgressV2['resources']>[number]['state'],
  () => string
> = {
  loading: () =>
    translate('auto.components.maestro.MaestroWorkspaceHarnessOverlay.resourceLoading', 'Loading'),
  active: () =>
    translate('auto.components.maestro.MaestroWorkspaceHarnessOverlay.resourceActive', 'Active'),
  input_required: () =>
    translate(
      'auto.components.maestro.MaestroWorkspaceHarnessOverlay.resourceInputRequired',
      'Input required'
    ),
  blocked: () =>
    translate('auto.components.maestro.MaestroWorkspaceHarnessOverlay.resourceBlocked', 'Blocked'),
  recovered: () =>
    translate(
      'auto.components.maestro.MaestroWorkspaceHarnessOverlay.resourceRecovered',
      'Recovered'
    ),
  unverifiable: () =>
    translate(
      'auto.components.maestro.MaestroWorkspaceHarnessOverlay.resourceUnverifiable',
      'Unverifiable'
    ),
  completed: () =>
    translate(
      'auto.components.maestro.MaestroWorkspaceHarnessOverlay.resourceCompleted',
      'Completed'
    ),
  error: () =>
    translate('auto.components.maestro.MaestroWorkspaceHarnessOverlay.resourceError', 'Error')
}

export function humanResourceDetail(resource: MaestroRunResource): string {
  if (resource.kind === 'browser' && resource.detail === 'Browser is unavailable.') {
    return translate(
      'auto.components.maestro.MaestroWorkspaceHarnessOverlay.browserUnavailableAction',
      'The owning host cannot verify this managed Browser page. Open a new Browser page from the Canvas to continue.'
    )
  }
  return resource.detail
}

export function humanResourceRows(progress: MaestroRunProgressV2): MaestroRunProgressRow[] {
  const resources = progress.resources ?? []
  const byReference = new Map(resources.map((resource) => [resource.reference, resource] as const))
  const children = new Map<string, typeof resources>()
  for (const resource of resources) {
    if (!resource.parent_reference || !byReference.has(resource.parent_reference)) {
      continue
    }
    children.set(resource.parent_reference, [
      ...(children.get(resource.parent_reference) ?? []),
      resource
    ])
  }
  const rows: MaestroRunProgressRow[] = []
  const visited = new Set<string>()
  const append = (resource: (typeof resources)[number], depth: number): void => {
    if (visited.has(resource.reference)) {
      return
    }
    visited.add(resource.reference)
    rows.push({
      key: `resource:${resource.kind}:${resource.reference}`,
      reference: resource.surface_key ?? resource.activation_reference ?? resource.reference,
      title: resource.title,
      workerLabel: RESOURCE_KIND_LABELS[resource.kind](),
      detail: humanResourceDetail(resource),
      state: resource.state,
      meta: RESOURCE_STATE_LABELS[resource.state](),
      depth
    })
    for (const child of children.get(resource.reference) ?? []) {
      append(child, depth + 1)
    }
  }
  for (const resource of resources) {
    if (!resource.parent_reference || !byReference.has(resource.parent_reference)) {
      append(resource, 0)
    }
  }
  for (const resource of resources) {
    append(resource, 0)
  }
  return rows
}

export function RunPanelControl({
  label,
  icon,
  onClick
}: {
  label: string
  icon: ReactNode
  onClick: () => void
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" size="icon-xs" variant="ghost" aria-label={label} onClick={onClick}>
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export const RUN_PANEL_ICONS = {
  compact: <ChevronDown />,
  expand: <Maximize2 />,
  hide: <EyeOff />
}

function legacyReferenceValue(reference: MaestroRunProgressReference): string {
  return [reference.task_id, reference.attempt_id, reference.finding_ref, reference.cleanup_id]
    .filter((value): value is string => Boolean(value))
    .join(' · ')
}

export function LegacyRunProgressSections({
  progress,
  onActivate
}: {
  progress: Extract<MaestroRunProgress, { available: true }>
  onActivate: (reference: string) => void
}): React.JSX.Element {
  const visibleCurrentTasks = progress.summary.current_tasks.filter((task) => {
    const count = progress.summary.task_counts[task.status]
    return count > 0
  })
  const taskRows = [...visibleCurrentTasks, ...progress.summary.next_tasks].map(
    (task): MaestroRunProgressRow => ({
      key: `${task.task_id}:${task.attempt_id ?? ''}`,
      reference: task.task_id,
      title: legacyTaskStatusTitle(task.status),
      detail: translate(
        'auto.components.maestro.MaestroWorkspaceHarnessOverlay.legacyTaskDetail',
        'This older host does not publish a human task summary.'
      ),
      state: task.status
    })
  )
  const blockedRows = progress.summary.blockers
    .slice(0, progress.summary.task_counts.blocked)
    .map((reference, index) => ({
      key: `blocked:${index}`,
      reference: reference.task_id ?? legacyReferenceValue(reference),
      title: translate(
        'auto.components.maestro.MaestroWorkspaceHarnessOverlay.legacyBlockedTask',
        'Blocked task'
      ),
      detail: translate(
        'auto.components.maestro.MaestroWorkspaceHarnessOverlay.legacyBlockedDetail',
        'This older host does not publish a human blocker summary.'
      ),
      state: 'blocked'
    }))
  return (
    <>
      <RunProgressSection
        label={translate(
          'auto.components.maestro.MaestroWorkspaceHarnessOverlay.legacyProgress',
          'Current work'
        )}
        rows={taskRows}
        onActivate={onActivate}
      />
      <RunProgressSection
        label={translate(
          'auto.components.maestro.MaestroWorkspaceHarnessOverlay.blockers',
          'Blocked'
        )}
        rows={blockedRows}
        onActivate={onActivate}
      />
    </>
  )
}

function legacyTaskStatusTitle(status: MaestroRunProgressRow['state']): string {
  const labels: Partial<Record<NonNullable<MaestroRunProgressRow['state']>, string>> = {
    running: 'Running task',
    input_required: 'Waiting for input',
    blocked: 'Blocked task',
    pending: 'Queued task',
    failed: 'Failed task'
  }
  return labels[status ?? 'pending'] ?? 'Task'
}
