import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRequestPreparation
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
