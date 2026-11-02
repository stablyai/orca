import { normalizeSshConfigAlias } from '../../../../shared/ssh-config-alias'
import type { SshTarget } from '../../../../shared/ssh-types'

export function isDuplicateSshTargetAlias({
  existingTargets,
  configHost,
  label,
  host
}: {
  existingTargets: readonly Pick<SshTarget, 'configHost' | 'label' | 'host'>[]
  configHost: string
  label: string
  host: string
}): boolean {
  // Normalize alias case exactly like the config picker’s ownership check.
  const alias =
    normalizeSshConfigAlias(configHost) ||
    normalizeSshConfigAlias(label) ||
    normalizeSshConfigAlias(host)
  if (!alias) {
    return false
  }
  return existingTargets.some((target) => getOccupiedAliases(target).includes(alias))
}

/** Both configHost and label reserve aliases, matching the picker’s disabled choices. */
function getOccupiedAliases(target: Pick<SshTarget, 'configHost' | 'label' | 'host'>): string[] {
  const occupied = [target.configHost, target.label].map(normalizeSshConfigAlias).filter(Boolean)
  return occupied.length > 0 ? occupied : [normalizeSshConfigAlias(target.host)].filter(Boolean)
}
