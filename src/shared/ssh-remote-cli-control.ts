import type { SshTarget } from './ssh-types'

/** On unless the user turned it off; a missing target (removed host) is never allowed. */
export function isRemoteCliControlAllowed(
  target: Pick<SshTarget, 'allowRemoteCliControl'> | null | undefined
): boolean {
  return target != null && target.allowRemoteCliControl !== false
}
