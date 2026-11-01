import type { SshConnectionState } from '../../../../shared/ssh-types'
import { persistedUIValuesEqual } from '../../../../shared/persisted-ui-equality'

export function sshConnectionStatesEqual(
  a: SshConnectionState | undefined,
  b: SshConnectionState
): boolean {
  return persistedUIValuesEqual(a, b)
}
