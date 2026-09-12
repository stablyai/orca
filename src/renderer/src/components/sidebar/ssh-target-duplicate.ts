import { normalizeSshConfigAlias } from '../../../../shared/ssh-config-alias'
import type { SshTarget } from '../../../../shared/ssh-types'

/** True when an existing Orca host already owns this config alias / label. */
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
  // Why: the config picker's `alreadyInOrca` flag compares lowercased aliases; match it or the
  // two checks disagree on case-only variants.
  const alias =
    normalizeSshConfigAlias(configHost) ||
    normalizeSshConfigAlias(label) ||
    normalizeSshConfigAlias(host)
  if (!alias) {
    return false
  }
  return existingTargets.some((target) => getOccupiedAliases(target).includes(alias))
}

/** Why: the picker treats configHost *and* label as owned, so the save check must too —
 *  otherwise an alias it greys out as "In Orca" is still savable as a second target. */
function getOccupiedAliases(target: Pick<SshTarget, 'configHost' | 'label' | 'host'>): string[] {
  const occupied = [target.configHost, target.label].map(normalizeSshConfigAlias).filter(Boolean)
  return occupied.length > 0 ? occupied : [normalizeSshConfigAlias(target.host)].filter(Boolean)
}
