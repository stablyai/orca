import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import { serializeRemoteRuntimePayload } from '../../../shared/remote-runtime-memory-limits'
import {
  prepareRemoteRuntimeRequest,
  releaseRemoteRuntimePreparedRequest,
  takeRemoteRuntimePreparedRequest,
  type RemoteRuntimePreparedRequest
} from '../../../shared/remote-runtime-prepared-request-admission'

const pendingPrerequisites = new Map<
  string,
  { preparedRequest: RemoteRuntimePreparedRequest | null }
>()
let nextRequestId = 0

export function prepareRuntimePrerequisiteParams(
  method: string,
  params: unknown,
  prerequisite: () => Promise<unknown>,
  signal?: AbortSignal
): Promise<unknown> {
  try {
    throwIfSignalAborted(signal)
    const pending = {
      preparedRequest: prepareRemoteRuntimeRequest(pendingPrerequisites, () =>
        serializeRemoteRuntimePayload({ method, params })
      )
    }
    const id = String(nextRequestId++)
    pendingPrerequisites.set(id, pending)
    return waitForPrerequisiteParams(id, pending, prerequisite, signal)
  } catch (error) {
    return Promise.reject(error)
  }
}

async function waitForPrerequisiteParams(
  id: string,
  pending: { preparedRequest: RemoteRuntimePreparedRequest | null },
  prerequisite: () => Promise<unknown>,
  signal?: AbortSignal
): Promise<unknown> {
  try {
    // Prerequisites need their own RPC slots; reserve memory without queueing execution.
    await waitForPromiseWithSignal(prerequisite(), signal)
    const serialized = takeRemoteRuntimePreparedRequest(pending)
    const request: unknown = serialized === null ? null : JSON.parse(serialized)
    return request !== null && typeof request === 'object' && 'params' in request
      ? request.params
      : undefined
  } finally {
    pendingPrerequisites.delete(id)
    releaseRemoteRuntimePreparedRequest(pending)
  }
}
