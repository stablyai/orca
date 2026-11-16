import { describe, expect, it } from 'vitest'
import { parseSkillShareId } from './skill-share-link'

describe('parseSkillShareId', () => {
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
