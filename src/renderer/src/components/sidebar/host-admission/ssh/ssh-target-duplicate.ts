import { normalizeSshConfigAlias } from '../../../../../../shared/remote-runtime/ssh/ssh-config-alias'
import { isSshConfigSourcedTarget } from '../../../../../../shared/remote-runtime/ssh/ssh-target-source'
import type { SshTarget } from '../../../../../../shared/remote-runtime/ssh/ssh-types'

export type SshTargetIdentity = Pick<
  SshTarget,
  'configHost' | 'label' | 'host' | 'port' | 'username' | 'source'
>

export function isDuplicateSshTarget(
  existingTargets: readonly SshTargetIdentity[],
  candidate: Pick<SshTarget, 'configHost' | 'host' | 'port' | 'username'>
): boolean {
  // Hosts and aliases compare case-insensitively, like the config picker’s ownership check.
  const host = normalizeSshConfigAlias(candidate.host)
  const alias = normalizeSshConfigAlias(candidate.configHost)
  if (alias && alias !== host) {
    return existingTargets.some((target) => getOccupiedAliases(target).includes(alias))
  }
  return existingTargets.some((target) => {
    // An imported config Host owns its name even without HostName: config sync keys on it.
    if (isSshConfigSourcedTarget(target)) {
      return getOccupiedAliases(target).includes(host)
    }
    const targetHost = normalizeSshConfigAlias(target.host)
    return (
      // A target on another host that reserves this name as its alias or label.
      (targetHost !== host && getOccupiedAliases(target).includes(host)) ||
      // Manual adds default configHost to host, so only port/user tell such targets apart.
      (normalizeSshConfigAlias(target.configHost) === host &&
        targetHost === host &&
        // A saved port 22 yields to the ssh -G Port at connect time, so it may be any port.
        (target.port === 22 || target.port === candidate.port) &&
        isSameSshUser(target.username, candidate.username))
    )
  })
}

/** Both configHost and label reserve aliases, matching the picker’s disabled choices. */
function getOccupiedAliases(target: SshTargetIdentity): string[] {
  const occupied = [target.configHost, target.label].map(normalizeSshConfigAlias).filter(Boolean)
  return occupied.length > 0 ? occupied : [normalizeSshConfigAlias(target.host)].filter(Boolean)
}

/** A blank user matches any user; otherwise users compare case-sensitively. */
function isSameSshUser(left: string, right: string): boolean {
  return !left || !right || left === right
}
