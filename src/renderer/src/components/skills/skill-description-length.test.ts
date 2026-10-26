import { describe, expect, it } from 'vitest'
import { isLongSkillDescription, SKILL_DESCRIPTION_CLAMP_CHARS } from './skill-description-length'

describe('isLongSkillDescription', () => {
  it('leaves a description that fits the clamp alone', () => {
    expect(isLongSkillDescription('Interact with Discord servers.')).toBe(false)
    expect(isLongSkillDescription('a'.repeat(SKILL_DESCRIPTION_CLAMP_CHARS))).toBe(false)
  })

  it('offers the toggle once a description runs past the clamp', () => {
    expect(isLongSkillDescription('a'.repeat(SKILL_DESCRIPTION_CLAMP_CHARS + 1))).toBe(true)
  })

  it('ignores surrounding whitespace and missing values', () => {
    expect(isLongSkillDescription(`  ${'a'.repeat(20)}  `)).toBe(false)
    expect(isLongSkillDescription(null)).toBe(false)
    expect(isLongSkillDescription(undefined)).toBe(false)
  })
})
