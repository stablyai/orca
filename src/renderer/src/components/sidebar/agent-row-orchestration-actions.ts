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
