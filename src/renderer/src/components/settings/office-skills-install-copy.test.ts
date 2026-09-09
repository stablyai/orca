import { describe, expect, it } from 'vitest'
import {
  officeSkillsInstalledMessage,
  officeSkillsPartialMessage
} from './office-skills-install-copy'

describe('office skills install copy', () => {
  it('keeps the noun singular for one skill', () => {
    // "Installed 1 skills." was the shape before the plural keys existed.
    expect(officeSkillsInstalledMessage(1)).toBe('Installed 1 skill.')
    expect(officeSkillsInstalledMessage(0)).toBe('Installed 0 skills.')
    expect(officeSkillsInstalledMessage(4)).toBe('Installed 4 skills.')
  })

  it('names the noun and both numbers when some failed', () => {
    // The previous wording dropped the noun entirely: "Installed 1; 1 could not be installed."
    expect(officeSkillsPartialMessage(1, 1)).toBe('Installed 1 of 2 skills.')
    expect(officeSkillsPartialMessage(0, 1)).toBe('Installed 0 of 1 skill.')
    expect(officeSkillsPartialMessage(3, 2)).toBe('Installed 3 of 5 skills.')
  })
})
