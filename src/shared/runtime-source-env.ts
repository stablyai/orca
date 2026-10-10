// Which Orca runtime launched a process. Kept separate from the orchestration compatibility stamp,
// whose WSL/SSH union carries caller attestation and must stay untouched.
export const RUNTIME_SOURCE_ID_ENV = 'ORCA_RUNTIME_SOURCE_ID'
export const RUNTIME_SOURCE_INCARNATION_ENV = 'ORCA_RUNTIME_SOURCE_INCARNATION'

export type RuntimeSourceStamp = {
  /** The launching profile's installation id; survives restarts. */
  sourceId: string
  /** The launching runtime's per-process id; only a hint that skips the probe. */
  incarnation: string
}

const MAX_SOURCE_FIELD_LENGTH = 256

function boundedValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed.length <= MAX_SOURCE_FIELD_LENGTH ? trimmed : undefined
}

export function readRuntimeSourceStamp(
  env: Readonly<Record<string, string | undefined>>
): RuntimeSourceStamp | null {
  const sourceId = boundedValue(env[RUNTIME_SOURCE_ID_ENV])
  const incarnation = boundedValue(env[RUNTIME_SOURCE_INCARNATION_ENV])
  return sourceId && incarnation ? { sourceId, incarnation } : null
}

/** Replaces any inherited stamp, so a nested Orca never passes on its parent's source. */
export function stampRuntimeSourceEnv(
  env: Record<string, string | undefined>,
  stamp: RuntimeSourceStamp | null
): void {
  delete env[RUNTIME_SOURCE_ID_ENV]
  delete env[RUNTIME_SOURCE_INCARNATION_ENV]
  if (stamp) {
    env[RUNTIME_SOURCE_ID_ENV] = stamp.sourceId
    env[RUNTIME_SOURCE_INCARNATION_ENV] = stamp.incarnation
  }
}
