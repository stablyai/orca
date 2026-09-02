import type { ManagedSkillInstall } from '../../../../shared/skill-install-contract'

export type SkillManagedInstallGroup = {
  key: string
  packageId: string
  versionId: string
  bundleDigest?: string
  destinationIdentity: string
  destination: ManagedSkillInstall['destination']
  installs: ManagedSkillInstall[]
}

function groupKey(install: ManagedSkillInstall): string {
  const identity = [
    install.destinationIdentity,
    install.packageId,
    install.versionId,
    install.bundleDigest ?? install.name
  ]
  return identity.join(':')
}

export function groupManagedSkillInstalls(
  installs: readonly ManagedSkillInstall[]
): SkillManagedInstallGroup[] {
  const groups = new Map<string, SkillManagedInstallGroup>()
  for (const install of installs) {
    const key = groupKey(install)
    const existing = groups.get(key)
    if (existing) {
      existing.installs.push(install)
      continue
    }
    groups.set(key, {
      key,
      packageId: install.packageId,
      versionId: install.versionId,
      ...(install.bundleDigest ? { bundleDigest: install.bundleDigest } : {}),
      destinationIdentity: install.destinationIdentity,
      destination: install.destination,
      installs: [install]
    })
  }
  return [...groups.values()].map((group) => ({
    ...group,
    installs: group.installs.sort((left, right) => left.name.localeCompare(right.name))
  }))
}

export function groupInstallState(group: SkillManagedInstallGroup): ManagedSkillInstall['state'] {
  if (group.installs.some((install) => install.state === 'modified')) {
    return 'modified'
  }
  return group.installs.some((install) => install.state === 'missing') ? 'missing' : 'unchanged'
}
