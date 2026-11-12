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
})
