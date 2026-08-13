import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { resolveTerminalHandleForPaneKey } from '@/components/dashboard/agent-row-orchestration-clipboard'

type CallRuntime = (request: {
  method: string
  params?: Record<string, unknown>
}) => Promise<RuntimeRpcResponse<unknown>>

export type ActiveWorkerDispatch = {
  workerHandle: string
  taskId: string
  dispatchId: string
}

const ACTIVE_DISPATCH_STATUSES = new Set(['pending', 'dispatched'])

function assertOk(response: RuntimeRpcResponse<unknown>): unknown {
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asActiveDispatch(
  workerHandle: string,
  taskId: unknown,
  dispatchId: unknown,
  status?: unknown
): ActiveWorkerDispatch | null {
  if (typeof taskId !== 'string' || typeof dispatchId !== 'string' || dispatchId.length === 0) {
    return null
  }
  if (status !== undefined && !ACTIVE_DISPATCH_STATUSES.has(String(status))) {
    return null
  }
  return { workerHandle, taskId, dispatchId }
}

// Why: workerList without --run is the existing global assignee view. taskList
// is Run-scoped and misses a lock owned by another coordinator Run.
async function findActiveDispatchInWorkerList(args: {
  workerHandle: string
  callRuntime: CallRuntime
}): Promise<ActiveWorkerDispatch | null> {
  const listed = assertOk(
    await args.callRuntime({
      method: 'orchestration.workerList',
      params: {}
    })
  )
  if (!isRecord(listed) || !Array.isArray(listed.workers)) {
    return null
  }
  for (const row of listed.workers) {
    if (!isRecord(row) || row.agentTerminalHandle !== args.workerHandle) {
      continue
    }
    const active = asActiveDispatch(
      args.workerHandle,
      row.taskId,
      row.dispatchId,
      row.dispatchStatus
    )
    if (active) {
      return active
    }
  }
  return null
}

async function findActiveDispatchInTaskList(args: {
  workerHandle: string
  coordinatorHandle: string
  callRuntime: CallRuntime
}): Promise<ActiveWorkerDispatch | null> {
  const listResult = assertOk(
    await args.callRuntime({
      method: 'orchestration.taskList',
      params: {
        status: 'dispatched',
        callerTerminalHandle: args.coordinatorHandle
      }
    })
  )
  if (!isRecord(listResult) || !Array.isArray(listResult.tasks)) {
    return null
  }
  for (const row of listResult.tasks) {
    if (!isRecord(row) || row.assignee_handle !== args.workerHandle) {
      continue
    }
    const active = asActiveDispatch(args.workerHandle, row.id, row.dispatch_id)
    if (active) {
      return active
    }
  }
  return null
}

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
// terminal.resolvePane round-trip when probing the lock.
export async function findActiveDispatchForWorkerHandle(args: {
  workerHandle: string
  coordinatorHandle?: string | null
  callRuntime: CallRuntime
}): Promise<ActiveWorkerDispatch | null> {
  const fromWorkerList = await findActiveDispatchInWorkerList(args)
  if (fromWorkerList) {
    return fromWorkerList
  }
  if (!args.coordinatorHandle) {
    return null
  }
  return findActiveDispatchInTaskList({
    workerHandle: args.workerHandle,
    coordinatorHandle: args.coordinatorHandle,
    callRuntime: args.callRuntime
  })
}

export async function failCreatedTask(args: {
  taskId: string
  coordinatorHandle: string
  callRuntime: CallRuntime
}): Promise<void> {
  try {
    assertOk(
      await args.callRuntime({
        method: 'orchestration.taskUpdate',
        params: {
          id: args.taskId,
          status: 'failed',
          callerTerminalHandle: args.coordinatorHandle
        }
      })
    )
  } catch {
    // Best-effort: surface the original dispatch error, not a cleanup failure.
  }
}
