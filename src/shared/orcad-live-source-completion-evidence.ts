import { z } from 'zod'

const references = {
  retirementRecordSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceRouteCheckpointSha256: z.string().regex(/^[a-f0-9]{64}$/)
}
const ordinary = z.object({ version: z.literal(1), ...references })
const successor = z.object({ version: z.literal(2), ...references })

/** References only; trusted profile code must join these hashes to retained evidence. */
export function parseOrcadLiveSourceCompletionEvidence(value: unknown) {
  return ordinary.parse(value)
}

/** Journal format selection is explicit; invalid ordinary evidence never falls back to successor. */
export function parseOrcadLiveCompletionEvidence(value: unknown) {
  return z.discriminatedUnion('version', [ordinary, successor]).parse(value)
}

export type OrcadLiveCompletionEvidence = ReturnType<typeof parseOrcadLiveCompletionEvidence>

export type OrcadLiveSourceCompletionEvidence = ReturnType<
  typeof parseOrcadLiveSourceCompletionEvidence
>
