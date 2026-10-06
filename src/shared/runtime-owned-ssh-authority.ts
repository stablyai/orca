import { isRuntimeOwnedSshTargetId } from './execution-host'
import { isSshRetainedIdentifier } from './ssh-retained-payload-admission'

export type RuntimeOwnedSshAuthority = {
  targetId: string
  connectionGeneration: number | null
}

export function admitRuntimeOwnedSshAuthority(value: unknown): RuntimeOwnedSshAuthority | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('targetId' in value) ||
    !isSshRetainedIdentifier(value.targetId) ||
    !isRuntimeOwnedSshTargetId(value.targetId) ||
    !('connectionGeneration' in value) ||
    (value.connectionGeneration !== null &&
      (typeof value.connectionGeneration !== 'number' ||
        !Number.isSafeInteger(value.connectionGeneration) ||
        value.connectionGeneration < 0))
  ) {
    return null
  }
  return { targetId: value.targetId, connectionGeneration: value.connectionGeneration }
}
