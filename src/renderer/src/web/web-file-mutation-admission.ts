import { serializeRemoteRuntimePayload } from '../../../shared/remote-runtime-memory-limits'
import {
  prepareRemoteRuntimeRequest,
  releaseRemoteRuntimePreparedRequest,
  takeRemoteRuntimePreparedRequest,
  type RemoteRuntimePreparedRequest
} from '../../../shared/remote-runtime-prepared-request-admission'

const pendingMutations = new Map<string, { preparedRequest: RemoteRuntimePreparedRequest | null }>()
let nextMutationId = 0

export async function withWebFileMutationAdmission(
  params: unknown,
  mutate: () => Promise<void>
): Promise<void> {
  const pending = {
    preparedRequest: prepareRemoteRuntimeRequest(pendingMutations, () =>
      serializeRemoteRuntimePayload(params)
    )
  }
  // Charge the retained inputs without occupying RPC slots their prerequisites need.
  takeRemoteRuntimePreparedRequest(pending)
  params = undefined
  const id = String(nextMutationId++)
  pendingMutations.set(id, pending)
  try {
    await mutate()
  } finally {
    pendingMutations.delete(id)
    releaseRemoteRuntimePreparedRequest(pending)
  }
}
