import { describe, expect, it } from 'vitest'
import { normalizeSkillBundleName } from './skill-bundle-name'

describe('normalizeSkillBundleName', () => {
  it('creates a plugin-compatible name from a human-readable label', () => {
    expect(normalizeSkillBundleName('Téam Skills -- v2.0')).toBe('team-skills-v2.0')
  })

  it('truncates without leaving a trailing separator', () => {
    expect(normalizeSkillBundleName(`${'a'.repeat(63)}.suffix`)).toBe('a'.repeat(63))
  })

  it('returns an empty name when the label has no supported characters', () => {
    expect(normalizeSkillBundleName('🔥')).toBe('')
  })
})
