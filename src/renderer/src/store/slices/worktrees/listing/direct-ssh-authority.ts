import { parseExecutionHostId, type ExecutionHostId } from '../../../../../../shared/execution-host'
import type { DirectSshAuthority } from '../../../../../../shared/ssh-types'
import type { AppState } from '../../../types'

export function directSshAuthorityIsComplete(
  authority: DirectSshAuthority,
  expectedTargetId: string
): boolean {
  if (
    authority.targetId !== expectedTargetId ||
    typeof authority.providerEpoch !== 'string' ||
    authority.providerEpoch.length === 0 ||
    !Number.isSafeInteger(authority.connectionGeneration) ||
    authority.connectionGeneration < 0
  ) {
    return false
  }
  return true
}

export function getCurrentDirectSshAuthority(
  state: Pick<AppState, 'sshConnectionStates'>,
  hostId: ExecutionHostId
): DirectSshAuthority | null {
  const parsedHost = parseExecutionHostId(hostId)
  if (parsedHost?.kind !== 'ssh') {
    return null
  }
  const connection = state.sshConnectionStates?.get(parsedHost.targetId)
  if (connection?.status !== 'connected') {
    return null
  }
  const authority = {
    targetId: parsedHost.targetId,
    providerEpoch: connection.providerEpoch,
    connectionGeneration: connection.connectionGeneration
  } as DirectSshAuthority
  if (!directSshAuthorityIsComplete(authority, parsedHost.targetId)) {
    return null
  }
  return {
    ...authority
  }
}

export function directSshAuthoritiesEqual(
  left: DirectSshAuthority | null | undefined,
  right: DirectSshAuthority | null | undefined
): boolean {
  if (!left || !right) {
    return false
  }
  return (
    left.targetId === right.targetId &&
    left.providerEpoch === right.providerEpoch &&
    left.connectionGeneration === right.connectionGeneration
  )
}
