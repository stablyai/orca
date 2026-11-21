import { describe, expect, it } from 'vitest'
import { compileRepoSearchPattern } from './repo-search-pattern'

describe('compileRepoSearchPattern', () => {
  it('matches the issue wildcard example across emoji', () => {
    const match = compileRepoSearchPattern('🎖️*crm')
    expect(match('🎖️ acme crm')).toBe(0)
    expect(match('x 🎖️-crm')).toBe(2)
    expect(match('🎩 acme crm')).toBe(-1)
  })

  it('matches the issue OR example and returns the earliest hit', () => {
    const match = compileRepoSearchPattern('🎖️||🎩')
    expect(match('🎩 billing')).toBe(0)
    expect(match('api 🎖️')).toBe(4)
    expect(match('plain')).toBe(-1)
  })

  it('keeps plain text as a substring match', () => {
    const match = compileRepoSearchPattern('orca')
    expect(match('my-orca-app')).toBe(3)
    expect(match('or ca')).toBe(-1)
  })

  it('escapes regex characters around wildcards', () => {
    const match = compileRepoSearchPattern('a.b*(c)')
    expect(match('a.b-(c)')).toBe(0)
    expect(match('axb-(c)')).toBe(-1)
    expect(match('a.b-c')).toBe(-1)
  })

  it('ignores empty OR terms', () => {
    expect(compileRepoSearchPattern('||')('anything')).toBe(-1)
    expect(compileRepoSearchPattern('api || ')('my-api')).toBe(3)
  })
})
