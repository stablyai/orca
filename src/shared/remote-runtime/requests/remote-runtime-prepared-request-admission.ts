import { RemoteRuntimeClientError } from '../remote-runtime-client-error'
import {
  REMOTE_RUNTIME_MAX_PENDING_REQUESTS,
  REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES,
  REMOTE_RUNTIME_MAX_PROCESS_PENDING_REQUESTS,
  REMOTE_RUNTIME_MAX_PROCESS_PENDING_RPC_BYTES,
  retainedRemoteRuntimeJsonStringBytes
} from '../remote-runtime-memory-limits'
import type { RuntimeRpcResponse } from '../../runtime-rpc-envelope'
import {
  remoteRuntimeRequestDispatchExpiredError,
  remoteRuntimeRequestParamsAtHandoff
} from './remote-runtime-request-dispatch-observation'

export type RemoteRuntimePreparedRequest = {
  retainedBytes: number
  serializedRequest: string | null
  releaseProcessAdmission: () => void
}

export type RemoteRuntimePendingRequest<TResult> = {
  resolve: (response: RuntimeRpcResponse<TResult>) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
  preparedRequest: RemoteRuntimePreparedRequest | null
  /** Local only: told when this request's own frame is handed to the socket. */
  onFrameSent?: () => void
  /** Throws when the request's end passed after its frame was sealed: it is not sent. */
  assertInTime?: () => void
}

type PendingPreparedRequest = {
  preparedRequest?: RemoteRuntimePreparedRequest | null
}

type ProcessRequestAdmission = {
  retainedBytes: number
}

const processRequestAdmissions = new Set<ProcessRequestAdmission>()

export function prepareRemoteRuntimeRequest(
  pendingRequests: ReadonlyMap<string, PendingPreparedRequest>,
  serialize: () => string
): RemoteRuntimePreparedRequest {
  if (
    pendingRequests.size >= REMOTE_RUNTIME_MAX_PENDING_REQUESTS ||
    processRequestAdmissions.size >= REMOTE_RUNTIME_MAX_PROCESS_PENDING_REQUESTS
  ) {
    throw remoteRuntimeRequestBusyError()
  }
  const serializedRequest = serialize()
  const retainedBytes = retainedRemoteRuntimeJsonStringBytes(serializedRequest)
  let alreadyRetainedBytes = 0
  for (const pending of pendingRequests.values()) {
    alreadyRetainedBytes += pending.preparedRequest?.retainedBytes ?? 0
  }
  if (retainedBytes > REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES - alreadyRetainedBytes) {
    throw remoteRuntimeRequestBusyError()
  }
  const releaseProcessAdmission = reserveProcessRequestAdmission(retainedBytes)
  if (!releaseProcessAdmission) {
    throw remoteRuntimeRequestBusyError()
  }
  return { retainedBytes, serializedRequest, releaseProcessAdmission }
}

export function takeRemoteRuntimePreparedRequest(pending: PendingPreparedRequest): string | null {
  const prepared = pending.preparedRequest
  if (!prepared || prepared.serializedRequest === null) {
    return null
  }
  const serializedRequest = prepared.serializedRequest
  prepared.serializedRequest = null
  return serializedRequest
}

/** Takes the frame's bytes at its actual handoff: the prepared ones, or `params` serialized again
 *  carrying only the time left (admission stays charged at the reserved size). Null when they were
 *  released; throws when the request's end passed, so nothing of it may be sent. */
export function takeRemoteRuntimePreparedRequestAtHandoff(
  pending: PendingPreparedRequest,
  params: unknown,
  serialize: (params: unknown) => string
): string | null {
  const atHandoff = remoteRuntimeRequestParamsAtHandoff(params)
  if (!atHandoff) {
    throw remoteRuntimeRequestDispatchExpiredError()
  }
  const prepared = takeRemoteRuntimePreparedRequest(pending)
  return prepared !== null && atHandoff.params !== params ? serialize(atHandoff.params) : prepared
}

export function releaseRemoteRuntimePreparedRequest(pending: PendingPreparedRequest): void {
  const prepared = pending.preparedRequest
  if (!prepared) {
    return
  }
  prepared.serializedRequest = null
  prepared.releaseProcessAdmission()
  prepared.retainedBytes = 0
  pending.preparedRequest = null
}

export function getRemoteRuntimeRequestAdmissionEvidence(): {
  pendingRequestCount: number
  retainedBytes: number
} {
  let retainedBytes = 0
  for (const admission of processRequestAdmissions) {
    retainedBytes += admission.retainedBytes
  }
  return { pendingRequestCount: processRequestAdmissions.size, retainedBytes }
}

export function toRemoteRuntimeRequestError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }
  return new RemoteRuntimeClientError('runtime_error', String(error))
}

function remoteRuntimeRequestBusyError(): RemoteRuntimeClientError {
  return new RemoteRuntimeClientError(
    'remote_runtime_busy',
    'Remote runtime request limit reached; retry after pending requests finish.'
  )
}

function reserveProcessRequestAdmission(retainedBytes: number): (() => void) | null {
  let alreadyRetainedBytes = 0
  for (const admission of processRequestAdmissions) {
    alreadyRetainedBytes += admission.retainedBytes
  }
  if (
    processRequestAdmissions.size >= REMOTE_RUNTIME_MAX_PROCESS_PENDING_REQUESTS ||
    retainedBytes > REMOTE_RUNTIME_MAX_PROCESS_PENDING_RPC_BYTES - alreadyRetainedBytes
  ) {
    return null
  }
  const admission = { retainedBytes }
  processRequestAdmissions.add(admission)
  return () => {
    admission.retainedBytes = 0
    processRequestAdmissions.delete(admission)
  }
}
