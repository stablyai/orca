import { describe, expect, it } from 'vitest'
import type { DiscoveredSkill } from '../../../../shared/skills'
import { SkillBundleManifestV1Schema } from '../../../../shared/skill-bundle-manifest'
import { derivedBundleName } from './skill-bundle-name'

function skill(name: string): DiscoveredSkill {
  return {
    id: `skill-${name}`,
    name,
    description: null,
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    rootPath: '/home/dev/.agents/skills',
    directoryPath: `/home/dev/.agents/skills/${name}`,
    skillFilePath: `/home/dev/.agents/skills/${name}/SKILL.md`,
    installed: true,
    updatedAt: null
  }
}

/** The publish call feeds this straight into the manifest, so anything this
 *  returns has to survive the schema that rejected `--`, uppercase, and >64. */
function isPublishable(name: string): boolean {
  return SkillBundleManifestV1Schema.shape.bundleName.safeParse(name).success
}

describe('derivedBundleName', () => {
  it('keeps a single skill name as the bundle name', () => {
    expect(derivedBundleName([skill('agent-discord')])).toBe('agent-discord')
  })

  it('distinguishes bundles by their first skill and how many others ride along', () => {
    const bundle = [skill('agent-discord'), skill('agent-slack'), skill('orca-cli')]
    expect(derivedBundleName(bundle)).toBe('agent-discord-and-2-more')
  })

  it('publishes distinct names for distinct bundles', () => {
    const first = derivedBundleName([skill('alpha'), skill('beta')])
    const second = derivedBundleName([skill('gamma'), skill('delta')])
    expect(first).not.toBe(second)
  })

  it('slugifies names the bundle schema would reject', () => {
    const name = derivedBundleName([skill('My Skill_v2'), skill('other')])
    expect(name).toBe('my-skill-v2-and-1-more')
    expect(isPublishable(name)).toBe(true)
  })

  it('stays within the 64-character limit without a trailing separator', () => {
    const name = derivedBundleName([skill('a'.repeat(80)), skill('other')])
    expect(name.length).toBeLessThanOrEqual(64)
    expect(isPublishable(name)).toBe(true)
  })

  it('falls back when a name slugifies to nothing', () => {
    expect(derivedBundleName([skill('///'), skill('other')])).toBe('shared-skills')
    expect(derivedBundleName([])).toBe('shared-skills')
  })
})
