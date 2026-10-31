import { RemoteRuntimeClientError } from '../remote-runtime-client-error'
import {
  REMOTE_RUNTIME_MAX_PENDING_REQUESTS,
  REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES,
  REMOTE_RUNTIME_MAX_PROCESS_PENDING_REQUESTS,
  REMOTE_RUNTIME_MAX_PROCESS_PENDING_RPC_BYTES,
  retainedRemoteRuntimeJsonStringBytes
} from '../remote-runtime-memory-limits'
import type { RuntimeRpcResponse } from '../../runtime-rpc-envelope'

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
}

type PendingPreparedRequest = {
  preparedRequest?: RemoteRuntimePreparedRequest | null
}

type ProcessRequestAdmission = {
  retainedBytes: number
}

const processRequestAdmissions = new Set<ProcessRequestAdmission>()
let processRetainedBytes = 0
const releaseListeners = new Set<() => void>()
export function subscribeRemoteRuntimeAdmissionRelease(listener: () => void): () => void {
  releaseListeners.add(listener)
  return () => {
    releaseListeners.delete(listener)
  }
}
function admissionReleased(): void {
  for (const listener of releaseListeners) {
    queueMicrotask(listener)
  }
}

export function prepareRemoteRuntimeRequest(
  pendingRequests: ReadonlyMap<unknown, PendingPreparedRequest>,
  serialize: () => string,
  retainedBytesOf: (serialized: string) => number = retainedRemoteRuntimeJsonStringBytes
): RemoteRuntimePreparedRequest {
  if (
    pendingRequests.size >= REMOTE_RUNTIME_MAX_PENDING_REQUESTS ||
    processRequestAdmissions.size >= REMOTE_RUNTIME_MAX_PROCESS_PENDING_REQUESTS
  ) {
    throw remoteRuntimeRequestBusyError()
  }
  const serializedRequest = serialize()
  const retainedBytes = retainedBytesOf(serializedRequest)
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
  return { pendingRequestCount: processRequestAdmissions.size, retainedBytes: processRetainedBytes }
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

export function reserveRemoteRuntimeRetainedBytes(
  retainedBytes: number
): { resize: (bytes: number) => boolean; release: () => void } | null {
  if (
    !Number.isSafeInteger(retainedBytes) ||
    retainedBytes < 0 ||
    processRequestAdmissions.size >= REMOTE_RUNTIME_MAX_PROCESS_PENDING_REQUESTS ||
    retainedBytes > REMOTE_RUNTIME_MAX_PROCESS_PENDING_RPC_BYTES - processRetainedBytes
  ) {
    return null
  }
  const admission = { retainedBytes }
  processRequestAdmissions.add(admission)
  processRetainedBytes += retainedBytes
  return {
    resize(bytes) {
      if (!processRequestAdmissions.has(admission) || !Number.isSafeInteger(bytes) || bytes < 0) {
        return false
      }
      const others = processRetainedBytes - admission.retainedBytes
      if (bytes > REMOTE_RUNTIME_MAX_PROCESS_PENDING_RPC_BYTES - others) {
        return false
      }
      const released = bytes < admission.retainedBytes
      processRetainedBytes += bytes - admission.retainedBytes
      admission.retainedBytes = bytes
      if (released) {
        admissionReleased()
      }
      return true
    },
    release() {
      if (processRequestAdmissions.delete(admission)) {
        processRetainedBytes -= admission.retainedBytes
        admission.retainedBytes = 0
        admissionReleased()
      }
    }
  }
}
function reserveProcessRequestAdmission(retainedBytes: number): (() => void) | null {
  return reserveRemoteRuntimeRetainedBytes(retainedBytes)?.release ?? null
}
