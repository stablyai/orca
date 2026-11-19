import { describe, expect, it } from 'vitest'
import { suggestRepoMonogram } from './repo-monogram'

describe('suggestRepoMonogram', () => {
  it('abbreviates names the way people do', () => {
    expect(suggestRepoMonogram('orca')).toBe('O')
    expect(suggestRepoMonogram('orca-internal')).toBe('OI')
    expect(suggestRepoMonogram('myApp')).toBe('MA')
    expect(suggestRepoMonogram('terraform_modules')).toBe('TM')
  })

  it('steps to a longer abbreviation when the short one is taken', () => {
    expect(suggestRepoMonogram('orca', ['O'])).toBe('OR')
    expect(suggestRepoMonogram('orca', ['o', 'OR'])).toBe('OC')
    expect(suggestRepoMonogram('orca-internal', ['OI'])).toBe('OR')
  })
})
