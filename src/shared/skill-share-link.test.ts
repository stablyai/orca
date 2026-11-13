import { describe, expect, it } from 'vitest'
import { parseSkillShareId } from './skill-share-link'

describe('parseSkillShareId', () => {
  it('accepts share links on both the orca.dev and legacy onorca.dev hosts', () => {
    expect(parseSkillShareId('https://share.orca.dev/skills/share/shr_new')).toBe('shr_new')
    expect(parseSkillShareId('https://share.onorca.dev/skills/share/shr_old')).toBe('shr_old')
  })

  it('rejects lookalike hosts', () => {
    expect(parseSkillShareId('https://share.orca.dev.evil.test/skills/share/shr_1')).toBeNull()
    expect(parseSkillShareId('https://evilshare.orca.dev/skills/share/shr_1')).toBeNull()
  })

  it('accepts links on a configured artifacts origin, and only that exact origin', () => {
    const staging = ['https://share-staging.onorca.dev']
    const link = 'https://share-staging.onorca.dev/skills/share/shr_stg'
    expect(parseSkillShareId(link)).toBeNull()
    expect(parseSkillShareId(link, staging)).toBe('shr_stg')
    expect(
      parseSkillShareId('http://share-staging.onorca.dev/skills/share/shr_stg', staging)
    ).toBeNull()
    expect(
      parseSkillShareId('https://share-staging.onorca.dev:8443/skills/share/x', staging)
    ).toBeNull()
    expect(parseSkillShareId('https://share-staging.onorca.dev/other/x', staging)).toBeNull()
  })

  it('keeps accepting production hosts when an origin is configured', () => {
    const staging = ['https://share-staging.onorca.dev']
    expect(parseSkillShareId('https://share.orca.dev/skills/share/shr_p', staging)).toBe('shr_p')
    expect(parseSkillShareId('orca://skills/share/shr_o', staging)).toBe('shr_o')
  })
})
