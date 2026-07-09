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

function readAskAnswer(result: unknown): { answer: string | null; timedOut: boolean } {
  if (!isRecord(result)) {
    return { answer: null, timedOut: true }
  }
  const answer = typeof result.answer === 'string' ? result.answer : null
  const timedOut = result.timedOut === true
  return { answer, timedOut }
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
  callRuntime: CallRuntime
}): Promise<ActiveWorkerDispatch | null> {
  const workerHandle = await resolveTerminalHandleForPaneKey({
    paneKey: args.workerPaneKey,
    callRuntime: args.callRuntime
  })
  const listResult = assertOk(
    await args.callRuntime({
      method: 'orchestration.taskList',
      params: { status: 'dispatched' }
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
      row.assignee_handle === workerHandle &&
      typeof row.id === 'string' &&
      typeof row.dispatch_id === 'string' &&
      row.dispatch_id.length > 0
    ) {
      return {
        workerHandle,
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
    'orca orchestration check --wait --types worker_done,escalation,decision_gate --timeout-ms 900000 --json'
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

  const active = await findActiveDispatchForWorker({
    workerPaneKey: args.workerPaneKey,
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
  timeoutMs?: number
  callRuntime: CallRuntime
}): Promise<{
  workerHandle: string
  coordinatorHandle: string
  answer: string | null
  timedOut: boolean
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
  const result = assertOk(
    await args.callRuntime({
      method: 'orchestration.ask',
      params: {
        to: workerHandle,
        from: coordinatorHandle,
        question,
        // Why: UI should not block for the CLI default (10m); keep a short wait
        // so the dialog can surface timeout vs answer without hanging forever.
        timeoutMs: args.timeoutMs ?? 120_000
      }
    })
  )
  const { answer, timedOut } = readAskAnswer(result)
  return { workerHandle, coordinatorHandle, answer, timedOut }
}
