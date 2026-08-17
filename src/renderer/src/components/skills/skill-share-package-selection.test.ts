import { describe, expect, it } from 'vitest'
import type { ManagedSkillInstall } from '../../../../shared/skill-install-contract'
import type { DiscoveredSkill } from '../../../../shared/skills'
import { matchingManagedSkillShareInstall } from './skill-share-package-selection'

function skill(name: string): DiscoveredSkill {
  return {
    id: `skill:${name}`,
    name,
    description: null,
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Home',
    rootPath: '/skills',
    directoryPath: `/skills/${name}`,
    skillFilePath: `/skills/${name}/SKILL.md`,
    installed: true,
    updatedAt: null
  }
}

function install(name: string, destinationIdentity = 'global:local'): ManagedSkillInstall {
  return {
    name,
    packageId: 'pkg_1',
    versionId: 'ver_1',
    packageDigest: 'a'.repeat(64),
    bundleDigest: 'b'.repeat(64),
    scope: 'global',
    destinationIdentity,
    destination: { scope: 'global' },
    installedAt: '2026-08-11T00:00:00.000Z',
    state: 'unchanged'
  }
}

describe('matchingManagedSkillShareInstall', () => {
  it('matches one complete managed bundle and rejects a partial selection', () => {
    const installs = [install('alpha'), install('beta')]

    expect(matchingManagedSkillShareInstall([skill('alpha'), skill('beta')], installs)).toBe(
      installs[0]
    )
    expect(matchingManagedSkillShareInstall([skill('alpha')], installs)).toBeNull()
  })

  it('rejects the same bundle installed at multiple destinations', () => {
    const installs = [
      install('alpha'),
      install('beta'),
      install('alpha', 'global:other'),
      install('beta', 'global:other')
    ]

    expect(matchingManagedSkillShareInstall([skill('alpha'), skill('beta')], installs)).toBeNull()
  })
})
