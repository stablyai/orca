import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { resolveTerminalHandleForPaneKey } from '@/components/dashboard/agent-row-orchestration-clipboard'

export type {
  ActiveTerminalPaneKeyState,
  CoordinatorCandidate
} from './agent-row-orchestration-coordinator'
export {
  getActiveTerminalPaneKey,
  listCoordinatorCandidates,
  resolveCoordinatorPaneKey
} from './agent-row-orchestration-coordinator'

type CallRuntime = (request: {
  method: string
  params?: Record<string, unknown>
}) => Promise<RuntimeRpcResponse<unknown>>

export type OrchestrationActionKind = 'dispatch' | 'send' | 'ask'

function assertOk(response: RuntimeRpcResponse<unknown>): unknown {
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readTaskId(result: unknown): string {
  if (!isRecord(result) || !isRecord(result.task) || typeof result.task.id !== 'string') {
    throw new Error('Task create did not return a task id')
  }
  return result.task.id
}

function readRunId(result: unknown): string | null {
  if (!isRecord(result) || !isRecord(result.run) || typeof result.run.id !== 'string') {
    return null
  }
  return result.run.id
}

// Why: taskCreate/taskList/dispatch now require a Run bound to the coordinator.
// Create one from the spec when the chosen terminal has no current Run.
async function ensureCoordinatorRun(args: {
  coordinatorHandle: string
  objective: string
  callRuntime: CallRuntime
}): Promise<string> {
  const currentId = readRunId(
    assertOk(
      await args.callRuntime({
        method: 'orchestration.runCurrent',
        params: { from: args.coordinatorHandle }
      })
    )
  )
  if (currentId) {
    return currentId
  }
  const createdId = readRunId(
    assertOk(
      await args.callRuntime({
        method: 'orchestration.runCreate',
        params: {
          objective: args.objective,
          from: args.coordinatorHandle
        }
      })
    )
  )
  if (!createdId) {
    throw new Error('Run create did not return a run id')
  }
  return createdId
}

export type ActiveWorkerDispatch = {
  workerHandle: string
  taskId: string
  dispatchId: string
}

// Why: the DB rejects a second active dispatch on the same assignee. Probe
// taskList so the menu can disable Dispatch before the RPC fails.
export async function findActiveDispatchForWorker(args: {
  workerPaneKey: string
  coordinatorPaneKey?: string | null
  callRuntime: CallRuntime
}): Promise<ActiveWorkerDispatch | null> {
  const workerHandle = await resolveTerminalHandleForPaneKey({
    paneKey: args.workerPaneKey,
    callRuntime: args.callRuntime
  })
  const coordinatorHandle = args.coordinatorPaneKey
    ? await resolveTerminalHandleForPaneKey({
        paneKey: args.coordinatorPaneKey,
        callRuntime: args.callRuntime
      })
    : null
  return findActiveDispatchForWorkerHandle({
    workerHandle,
    coordinatorHandle,
    callRuntime: args.callRuntime
  })
}

// Why: dispatch already resolved the worker handle; reuse it instead of a second
// terminal.resolvePane round-trip when probing taskList.
async function findActiveDispatchForWorkerHandle(args: {
  workerHandle: string
  coordinatorHandle?: string | null
  callRuntime: CallRuntime
}): Promise<ActiveWorkerDispatch | null> {
  const listResult = assertOk(
    await args.callRuntime({
      method: 'orchestration.taskList',
      params: {
        status: 'dispatched',
        // Why: taskList is Run-scoped; without a caller the RPC throws run_required.
        ...(args.coordinatorHandle ? { callerTerminalHandle: args.coordinatorHandle } : {})
      }
    })
  )
  if (!isRecord(listResult) || !Array.isArray(listResult.tasks)) {
    return null
  }
  for (const row of listResult.tasks) {
    if (!isRecord(row)) {
      continue
    }
    if (
      row.assignee_handle === args.workerHandle &&
      typeof row.id === 'string' &&
      typeof row.dispatch_id === 'string' &&
      row.dispatch_id.length > 0
    ) {
      return {
        workerHandle: args.workerHandle,
        taskId: row.id,
        dispatchId: row.dispatch_id
      }
    }
  }
  return null
}

export function formatCoordinatorWaitHint(): string {
  return (
    'On the coordinator terminal, run:\n' +
    'orca orchestration check --wait --types worker_done,escalation,question --timeout-ms 900000 --json'
  )
}

export async function resolveCoordinatorAndWorkerHandles(args: {
  workerPaneKey: string
  coordinatorPaneKey: string | null
  callRuntime: CallRuntime
}): Promise<{ coordinatorHandle: string; workerHandle: string }> {
  if (!args.coordinatorPaneKey) {
    throw new Error(
      'No other terminal found to use as coordinator. Open/focus another agent terminal in this worktree, then try again.'
    )
  }
  if (args.coordinatorPaneKey === args.workerPaneKey) {
    throw new Error(
      'Coordinator and worker are the same terminal. Open/focus another agent terminal as coordinator.'
    )
  }
  // Why: CallRuntime accepts a wider method string than resolveTerminalHandleForPaneKey's
  // literal 'terminal.resolvePane'; parameter contravariance still allows this call.
  const [coordinatorHandle, workerHandle] = await Promise.all([
    resolveTerminalHandleForPaneKey({
      paneKey: args.coordinatorPaneKey,
      callRuntime: args.callRuntime
    }),
    resolveTerminalHandleForPaneKey({
      paneKey: args.workerPaneKey,
      callRuntime: args.callRuntime
    })
  ])
  if (coordinatorHandle === workerHandle) {
    throw new Error(
      'Coordinator and worker resolve to the same terminal handle. Focus a different terminal as coordinator.'
    )
  }
  return { coordinatorHandle, workerHandle }
}

export async function dispatchTaskToAgent(args: {
  workerPaneKey: string
  coordinatorPaneKey: string | null
  spec: string
  inject?: boolean
  callRuntime: CallRuntime
}): Promise<{
  taskId: string
  workerHandle: string
  coordinatorHandle: string
  injected: boolean
}> {
  const spec = args.spec.trim()
  if (!spec) {
    throw new Error('Task spec is required')
  }
  const { coordinatorHandle, workerHandle } = await resolveCoordinatorAndWorkerHandles({
    workerPaneKey: args.workerPaneKey,
    coordinatorPaneKey: args.coordinatorPaneKey,
    callRuntime: args.callRuntime
  })

  await ensureCoordinatorRun({
    coordinatorHandle,
    objective: spec,
    callRuntime: args.callRuntime
  })

  const active = await findActiveDispatchForWorkerHandle({
    workerHandle,
    coordinatorHandle,
    callRuntime: args.callRuntime
  })
  if (active) {
    throw new Error(
      `This agent already has an active dispatch (${active.dispatchId} for task ${active.taskId}). Wait for worker_done or fail the task before dispatching again.`
    )
  }

  const createResult = assertOk(
    await args.callRuntime({
      method: 'orchestration.taskCreate',
      params: {
        spec,
        callerTerminalHandle: coordinatorHandle
      }
    })
  )
  const taskId = readTaskId(createResult)

  const dispatchResult = assertOk(
    await args.callRuntime({
      method: 'orchestration.dispatch',
      params: {
        task: taskId,
        to: workerHandle,
        from: coordinatorHandle,
        inject: args.inject !== false
      }
    })
  )
  const injected =
    isRecord(dispatchResult) && typeof dispatchResult.injected === 'boolean'
      ? dispatchResult.injected
      : false

  return { taskId, workerHandle, coordinatorHandle, injected }
}

export async function sendMessageToAgent(args: {
  workerPaneKey: string
  coordinatorPaneKey: string | null
  subject: string
  body?: string
  callRuntime: CallRuntime
}): Promise<{ workerHandle: string; coordinatorHandle: string }> {
  const subject = args.subject.trim()
  if (!subject) {
    throw new Error('Subject is required')
  }
  const { coordinatorHandle, workerHandle } = await resolveCoordinatorAndWorkerHandles({
    workerPaneKey: args.workerPaneKey,
    coordinatorPaneKey: args.coordinatorPaneKey,
    callRuntime: args.callRuntime
  })
  assertOk(
    await args.callRuntime({
      method: 'orchestration.send',
      params: {
        to: workerHandle,
        from: coordinatorHandle,
        subject,
        body: args.body?.trim() || undefined,
        type: 'status'
      }
    })
  )
  return { workerHandle, coordinatorHandle }
}

export async function askAgent(args: {
  workerPaneKey: string
  coordinatorPaneKey: string | null
  question: string
  callRuntime: CallRuntime
}): Promise<{
  workerHandle: string
  coordinatorHandle: string
}> {
  const question = args.question.trim()
  if (!question) {
    throw new Error('Question is required')
  }
  const { coordinatorHandle, workerHandle } = await resolveCoordinatorAndWorkerHandles({
    workerPaneKey: args.workerPaneKey,
    coordinatorPaneKey: args.coordinatorPaneKey,
    callRuntime: args.callRuntime
  })
  // Why: orchestration.ask is now worker→Run (requires an active Dispatch on
  // --from). Coordinator→worker questions go through send --type question.
  assertOk(
    await args.callRuntime({
      method: 'orchestration.send',
      params: {
        to: workerHandle,
        from: coordinatorHandle,
        subject: question,
        type: 'question'
      }
    })
  )
  return { workerHandle, coordinatorHandle }
}
