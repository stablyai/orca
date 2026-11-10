import { describe, expect, it } from 'vitest'
import { parseSkillShareId } from './skill-share-link'

describe('parseSkillShareId', () => {
  it('rejects attacker origins and lookalike paths', () => {
    expect(parseSkillShareId('https://attacker.test/skills/share/share_123')).toBeNull()
    expect(parseSkillShareId('https://app.orca.dev/skills/share/share_123/more')).toBeNull()
    expect(parseSkillShareId('javascript:share_123')).toBeNull()
  })
})
