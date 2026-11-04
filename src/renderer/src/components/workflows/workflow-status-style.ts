import { isWorkflowAgentNode } from '../../../../shared/workflow/workflow-definition-schema'
import type {
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowTaskStatus
} from '../../../../shared/workflow/workflow-run-types'
import { translate } from '@/i18n/i18n'

type StatusStyle = { label: string; dot: string; text: string; frame: string }

const MUTED: StatusStyle = {
  label: '',
  dot: 'bg-muted-foreground/40',
  text: 'text-muted-foreground',
  frame: ''
}
const RUNNING: StatusStyle = {
  label: translate('auto.components.workflows.workflow.status.style.d84632bb0f', 'Running'),
  dot: 'bg-agent-working animate-pulse motion-reduce:animate-none',
  text: 'text-foreground',
  frame: 'border-agent-working/60'
}
const WAITING: StatusStyle = {
  label: translate('auto.components.workflows.workflow.status.style.f5aece3f02', 'Waiting'),
  dot: 'bg-status-warning',
  text: 'text-status-warning-text',
  frame: 'border-status-warning-border'
}

/** Color marks state only: running, done, failed, waiting; everything else stays neutral. */
export const WORKFLOW_TASK_STATUS_STYLE: Record<WorkflowTaskStatus, StatusStyle> = {
  pending: {
    ...MUTED,
    label: translate('auto.components.workflows.workflow.status.style.38fa5d20f7', 'Pending')
  },
  ready: {
    ...MUTED,
    label: translate('auto.components.workflows.workflow.status.style.3b7164143b', 'Ready')
  },
  dispatched: {
    ...RUNNING,
    label: translate('auto.components.workflows.workflow.status.style.ba49ccaf62', 'Starting')
  },
  running: RUNNING,
  blocked: {
    ...WAITING,
    label: translate('auto.components.workflows.workflow.status.style.02928ed464', 'Held input')
  },
  'awaiting-approval': {
    ...WAITING,
    label: translate('auto.components.workflows.workflow.status.style.f92bde0aa9', 'Needs approval')
  },
  completed: {
    label: translate('auto.components.workflows.workflow.status.style.378ba8c7fb', 'Completed'),
    dot: 'bg-status-success',
    text: 'text-status-success',
    frame: 'border-status-success-border'
  },
  failed: {
    label: translate('auto.components.workflows.workflow.status.style.01a5290b62', 'Failed'),
    dot: 'bg-destructive',
    text: 'text-destructive',
    frame: 'border-destructive/60'
  },
  skipped: {
    ...MUTED,
    label: translate('auto.components.workflows.workflow.status.style.dfc4cb24dc', 'Skipped')
  },
  cancelled: {
    ...MUTED,
    label: translate('auto.components.workflows.workflow.status.style.97ed74c396', 'Cancelled')
  },
  unknown: {
    ...MUTED,
    label: translate('auto.components.workflows.workflow.status.style.03713849fb', 'Unconfirmed'),
    frame: 'border-dashed border-muted-foreground/60'
  }
}

export const WORKFLOW_RUN_STATUS_LABEL: Record<WorkflowRunStatus, string> = {
  validating: 'Starting',
  running: 'Running',
  paused: 'Paused',
  'awaiting-approval': 'Needs approval',
  completed: 'Completed',
  failed: 'Failed',
  cancelling: 'Cancelling',
  cancelled: 'Cancelled'
}

export function formatWorkflowDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) {
    return '—'
  }
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function workflowNodeRunSummary(run: WorkflowRun, nodeId: string) {
  const iteration = run.iterationByNode[nodeId] ?? 0
  const task = run.tasks[`${nodeId}#${iteration}`]
  const dispatch = task?.dispatches.at(-1)
  const node = run.definition.nodes.find((candidate) => candidate.id === nodeId)
  const end = task?.settledAt ? Date.parse(task.settledAt) : Date.now()
  const start = task?.startedAt ? Date.parse(task.startedAt) : null
  return {
    status: task?.status ?? 'pending',
    iteration,
    attempt: task?.dispatches.length ?? 0,
    agent:
      dispatch?.effective?.agent ??
      (node && isWorkflowAgentNode(node) ? node.agent.runtime.agent : null),
    model: dispatch ? (dispatch.effective?.model ?? 'default model') : null,
    elapsed: start === null ? '' : formatWorkflowDuration(end - start),
    messages: run.messages.filter(
      (message) => message.sourceNodeId === nodeId || message.destinationNodeId === nodeId
    ).length
  }
}
