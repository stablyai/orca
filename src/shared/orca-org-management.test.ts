import { describe, expect, it } from 'vitest'
import { isValidOrgName } from './orca-org-management'

describe('isValidOrgName', () => {
  it('accepts the sign-in provider character set up to 64 characters', () => {
    expect(isValidOrgName('Acme Engineering')).toBe(true)
    expect(isValidOrgName('team_42')).toBe(true)
    expect(isValidOrgName('a'.repeat(64))).toBe(true)
  })
  it('rejects punctuation, empty names and names over 64 characters', () => {
    expect(isValidOrgName('Acme, Inc.')).toBe(false)
    expect(isValidOrgName('   ')).toBe(false)
    expect(isValidOrgName('a'.repeat(65))).toBe(false)
  })
})
