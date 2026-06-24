import { describe, expect, it } from 'vitest'
import { buildGithubPrSearchUrl } from './github-pr-search-url'

describe('buildGithubPrSearchUrl', () => {
  it('builds a head-ref PR search URL for the repo', () => {
    expect(buildGithubPrSearchUrl('acme/app', 'fix/login')).toBe(
      'https://github.com/acme/app/pulls?q=is%3Apr%20head%3Afix%2Flogin'
    )
  })

  it('encodes branch names with slashes and special characters', () => {
    expect(buildGithubPrSearchUrl('acme/app', 'feat/a+b')).toContain('head%3Afeat%2Fa%2Bb')
  })
})
