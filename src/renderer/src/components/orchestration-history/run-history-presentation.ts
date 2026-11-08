import { getIntlLocale, translate } from '@/i18n/i18n'
import type { RunEvent } from '../../../../shared/orchestration-run-events'

export function runEventLabel(kind: RunEvent['kind']): string {
  switch (kind) {
    case 'run.created':
      return translate('orchestrationHistory.runCreated', 'Run created')
    case 'run.coordinator_changed':
      return translate('orchestrationHistory.coordinatorChanged', 'Coordinator changed')
    case 'task.created':
      return translate('orchestrationHistory.taskCreated', 'Task created')
    case 'task.status_changed':
      return translate('orchestrationHistory.taskChanged', 'Task status changed')
    case 'task.removed':
      return translate('orchestrationHistory.taskRemoved', 'Task record removed')
    case 'dispatch.created':
      return translate('orchestrationHistory.attemptCreated', 'Worker attempt created')
    case 'dispatch.status_changed':
      return translate('orchestrationHistory.attemptChanged', 'Worker attempt changed')
    case 'dispatch.removed':
      return translate('orchestrationHistory.attemptRemoved', 'Worker attempt record removed')
    case 'gate.created':
      return translate('orchestrationHistory.gateCreated', 'Decision requested')
    case 'gate.status_changed':
      return translate('orchestrationHistory.gateChanged', 'Decision status changed')
    case 'gate.removed':
      return translate('orchestrationHistory.gateRemoved', 'Decision record removed')
  }
}

export function runEventStatus(status: string): string {
  switch (status) {
    case 'pending':
      return translate('orchestrationHistory.pending', 'Pending')
    case 'ready':
      return translate('orchestrationHistory.ready', 'Ready')
    case 'dispatched':
      return translate('orchestrationHistory.assigned', 'Assigned')
    case 'completed':
      return translate('orchestrationHistory.completed', 'Completed')
    case 'failed':
      return translate('orchestrationHistory.failed', 'Failed')
    case 'blocked':
      return translate('orchestrationHistory.blocked', 'Blocked')
    case 'circuit_broken':
      return translate('orchestrationHistory.retriesStopped', 'Retries stopped')
    case 'resolved':
      return translate('orchestrationHistory.resolved', 'Resolved')
    case 'timeout':
      return translate('orchestrationHistory.timedOut', 'Timed out')
    default:
      return status
  }
}

export function runHistoryTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(getIntlLocale(), { dateStyle: 'medium', timeStyle: 'medium' }).format(
        date
      )
}

export function runEventDetails(
  event: RunEvent,
  taskTitles: ReadonlyMap<string, string>
): { id: string; text: string; literal?: boolean }[] {
  const details: { id: string; text: string; literal?: boolean }[] = []
  const title = event.data.title ?? (event.taskId ? taskTitles.get(event.taskId) : undefined)
  if (title) {
    details.push({ id: 'title', text: title })
  }
  if (event.data.status) {
    details.push({
      id: 'status',
      text: event.data.previousStatus
        ? `${runEventStatus(event.data.previousStatus)} → ${runEventStatus(event.data.status)}`
        : runEventStatus(event.data.status)
    })
  }
  if (event.kind === 'run.coordinator_changed') {
    const unbound = translate('orchestrationHistory.unbound', 'Unbound')
    details.push({
      id: 'coordinator',
      literal: true,
      text: `${event.data.previousCoordinator ?? unbound} → ${event.data.coordinator ?? unbound}`
    })
  } else if (event.data.coordinator) {
    details.push({ id: 'coordinator', text: event.data.coordinator, literal: true })
  }
  if (event.data.assignee) {
    details.push({ id: 'assignee', text: event.data.assignee, literal: true })
  }
  if (event.data.retryOfDispatchId) {
    details.push({
      id: 'retry',
      literal: true,
      text: translate('orchestrationHistory.retryOf', 'Retry of {{id}}', {
        id: event.data.retryOfDispatchId
      })
    })
  }
  return details
}
