import { TUI_AGENT_CONFIG } from './tui-agent-config'

// Why: dispatch and worker-start used to flatten these refusals to runtime_error, so an agent
// reading the receipt could not tell "create the task" from "wait on deps" from "pick another
// terminal". This module is the single source of each receipt's code, message, and data so the
// runtime emits it and the CLI test formats exactly the same envelope. Recovery rides in
// data.nextSteps, which every shipped CLI already prints for any code.

export type DispatchRefusalReceipt = {
  code: 'task_not_found' | 'task_not_startable' | 'inject_rejected'
  message: string
  data: Record<string, unknown> & { nextSteps: string[] }
}

export function taskNotFoundRefusal(taskId: string, runId?: string): DispatchRefusalReceipt {
  return {
    code: 'task_not_found',
    message: runId
      ? `Task ${taskId} was not found in Run ${runId}.`
      : `Task ${taskId} was not found.`,
    data: {
      taskId,
      ...(runId ? { runId } : {}),
      nextSteps: [
        'Run orca orchestration task-list --json in the bound Run to find the intended Task id.',
        'If the Task does not exist yet, create it with orca orchestration task-create --spec <text> --json.'
      ]
    }
  }
}

export function taskNotStartableRefusal(task: {
  taskId: string
  status: string
  unmetDependencies: string[]
}): DispatchRefusalReceipt {
  const nextSteps =
    task.unmetDependencies.length > 0
      ? [
          `Wait for ${task.unmetDependencies.join(', ')} to complete (orca orchestration check --wait --json), then dispatch again.`
        ]
      : task.status === 'dispatched'
        ? [
            'The Task already has an active Dispatch; inspect it with orca orchestration dispatch-show --task <task_id> --json.'
          ]
        : [
            `A ${task.status} Task cannot be dispatched; create a new Task or use worker-start --retry-of for a failed attempt.`
          ]
  return {
    code: 'task_not_startable',
    message: `Task ${task.taskId} is ${task.status}; only ready tasks can be dispatched`,
    data: { ...task, nextSteps }
  }
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
