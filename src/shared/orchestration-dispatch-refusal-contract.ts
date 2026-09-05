import { TUI_AGENT_CONFIG } from './tui-agent-config'

// Why: one source for each dispatch refusal's code, message, and data, so the runtime emits and
// the CLI test formats the identical envelope. Messages are supplied per call site because each
// existing string is a published receipt an old consumer may match on.

export type DispatchRefusalReceipt = {
  code: 'task_not_found' | 'task_not_startable' | 'inject_rejected'
  message: string
  data: Record<string, unknown> & { nextSteps: string[] }
}

export function taskNotFoundRefusal(
  message: string,
  detail: { taskId: string; runId?: string }
): DispatchRefusalReceipt {
  return {
    code: 'task_not_found',
    message,
    data: {
      ...detail,
      nextSteps: [
        'Run orca orchestration task-list --json in the bound Run to find the intended Task id.',
        'If the Task does not exist yet, create it with orca orchestration task-create --spec <text> --json.'
      ]
    }
  }
}

export type TaskNotStartableDetail = {
  taskId: string
  status: string
  unmetDependencies: string[]
  retryOf?: string
}

export function taskNotStartableRefusal(
  message: string,
  detail: TaskNotStartableDetail
): DispatchRefusalReceipt {
  return {
    code: 'task_not_startable',
    message,
    data: { ...detail, nextSteps: taskNotStartableNextSteps(detail) }
  }
}

function taskNotStartableNextSteps(detail: TaskNotStartableDetail): string[] {
  if (detail.retryOf) {
    return [
      `--retry-of must name the latest settled Dispatch of a failed or blocked Task; check orca orchestration dispatch-show --task ${detail.taskId} --json and orca orchestration worker-show --dispatch ${detail.retryOf} --json.`
    ]
  }
  if (detail.unmetDependencies.length > 0) {
    return [
      `Dependencies ${detail.unmetDependencies.join(', ')} are not completed. Wait for running ones with orca orchestration check --wait --json; retry or unblock failed ones before dispatching again.`
    ]
  }
  if (detail.status === 'dispatched') {
    return [
      `The Task already has an active Dispatch; inspect it with orca orchestration dispatch-show --task ${detail.taskId} --json.`
    ]
  }
  return [
    `A ${detail.status} Task cannot be dispatched; create a new Task or use worker-start --retry-of for a failed attempt.`
  ]
}

// Why: the old five-name example read as an allowlist (#15125); derive from the field detection keys on so it cannot drift.
// Not filtered by `disabledTuiAgents` — that gates Orca's launchers, not detection, so a hand-started disabled agent still injects.
const RECOGNIZED_AGENT_PROCESS_NAMES = [
  ...new Set(Object.values(TUI_AGENT_CONFIG).map((config) => config.expectedProcess))
].sort()

export function buildInjectRejectionMessage(terminal: string): string {
  return (
    `Cannot dispatch --inject to terminal ${terminal}: no recognized agent detected. ` +
    `Orca detects these agent CLIs (${RECOGNIZED_AGENT_PROCESS_NAMES.join(', ')}). ` +
    'Start one in the terminal and let it finish launching, ' +
    'or dispatch without --inject and send the prompt manually.'
  )
}

export type InjectRejectionReason = 'no_agent_detected'

export function injectRejectedRefusal(
  terminal: string,
  reason: InjectRejectionReason
): DispatchRefusalReceipt {
  return {
    code: 'inject_rejected',
    message: buildInjectRejectionMessage(terminal),
    data: {
      terminal,
      reason,
      nextSteps: [
        'Start a recognized agent CLI in that terminal and wait for it to finish launching, or pick a terminal that already runs one.',
        'Alternatively dispatch without --inject and deliver the prompt with orca terminal send --terminal <handle> --text <prompt> --enter --json.'
      ]
    }
  }
}
