import { randomUUID } from 'node:crypto'
import {
  serializeRemoteRuntimePayload,
  serializeRemoteRuntimeRpcRequest
} from '../remote-runtime-memory-limits'
import { prepareRemoteRuntimeRequest } from './remote-runtime-prepared-request-admission'
import type { PairedRuntimeConnection } from '../pairing/paired-runtime-connection'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRequestPreparation,
  RuntimeRequestGuard
} from '../../runtime-rpc-envelope'

type SerializeRequest = (
  params: unknown,
  envelope: RuntimeOrchestrationEnvelope | undefined
) => string

/** Serializes one request, letting the caller's preparation pick its params against their exact wire size. */
export function serializePreparedRemoteRuntimeRequest(
  serialize: SerializeRequest,
  params: unknown,
  envelope: RuntimeOrchestrationEnvelope | undefined,
  prepareRequest: RuntimeRequestPreparation | undefined
): string {
  if (!prepareRequest) {
    return serialize(params, envelope)
  }
  let measured:
    | { params: unknown; envelope: RuntimeOrchestrationEnvelope | undefined; serialized: string }
    | undefined
  const selected = prepareRequest({
    params,
    envelope,
    measure: (candidateParams, candidateEnvelope) => {
      const serialized = serialize(candidateParams, candidateEnvelope)
      measured = { params: candidateParams, envelope: candidateEnvelope, serialized }
      return Buffer.byteLength(serialized, 'utf8')
    }
  })
  return measured && measured.params === selected.params && measured.envelope === selected.envelope
    ? measured.serialized
    : serialize(selected.params, selected.envelope)
}

/** Validate prepared authority and its final live fence without yielding before dispatch. */
export async function prepareCurrentRuntimeRequest(args: {
  connection: PairedRuntimeConnection
  guard?: RuntimeRequestGuard
  current: () => boolean
  deadline: number
  expire: () => void
  consume: () => void
}): Promise<void> {
  for (;;) {
    const commit = await args.guard?.(args.connection)
    if (!args.current()) {
      return
    }
    if (performance.now() >= args.deadline) {
      args.expire()
      return
    }
    if (commit?.() !== false) {
      args.consume()
      return
    }
  }
}

export function prepareRuntimeSocketRequest(
  connection: PairedRuntimeConnection,
  method: string,
  params: unknown,
  envelope: RuntimeOrchestrationEnvelope | undefined,
  prepareRequest: RuntimeRequestPreparation | undefined,
  validateStatus: boolean,
  selectAfterStatus: boolean
) {
  const requestId = randomUUID()
  const statusRequestId = validateStatus ? randomUUID() : null
  const serializedStatusRequest = statusRequestId
    ? serializeRemoteRuntimePayload({
        id: statusRequestId,
        deviceToken: connection.credential.deviceToken,
        method: 'status.get'
      })
    : null
  const prepare = (selectedParams: unknown) =>
    prepareRemoteRuntimeRequest(new Map(), () =>
      serializePreparedRemoteRuntimeRequest(
        (selected, selectedEnvelope) =>
          serializeRemoteRuntimeRpcRequest({
            requestId,
            deviceToken: connection.credential.deviceToken,
            method,
            params: selected,
            envelope: selectedEnvelope
          }),
        selectedParams,
        envelope,
        prepareRequest
      )
    )
  const pendingRequest: { preparedRequest: ReturnType<typeof prepare> | null } = {
    preparedRequest:
      selectAfterStatus && serializedStatusRequest
        ? prepareRemoteRuntimeRequest(new Map(), () => serializedStatusRequest)
        : prepare(params)
  }
  return { requestId, statusRequestId, serializedStatusRequest, prepare, pendingRequest }
}
