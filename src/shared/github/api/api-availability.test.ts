import { describe, expect, it } from 'vitest'
import { classifyGitHubUnavailable } from './api-availability'

describe('classifyGitHubUnavailable', () => {
  it('classifies rate limiting as rate_limited (even when it carries HTTP 403)', () => {
    expect(classifyGitHubUnavailable('HTTP 403: API rate limit exceeded')).toBe('rate_limited')
    expect(classifyGitHubUnavailable('You have exceeded a secondary rate limit')).toBe(
      'rate_limited'
    )
    expect(classifyGitHubUnavailable('HTTP 429 Too Many Requests')).toBe('rate_limited')
  })

  it('returns null for non-reachability failures', () => {
    expect(classifyGitHubUnavailable('HTTP 403: Resource not accessible by integration')).toBeNull()
    expect(classifyGitHubUnavailable('HTTP 404: Not Found')).toBeNull()
    expect(classifyGitHubUnavailable('could not resolve to a Repository with the name')).toBeNull()
    expect(
      classifyGitHubUnavailable(
        "GraphQL: Could not resolve to a Repository with the name 'network'."
      )
    ).toBeNull()
    expect(classifyGitHubUnavailable('gh auth login required')).toBeNull()
    expect(classifyGitHubUnavailable('')).toBeNull()
  })

  it('does not misread unrelated 3-digit numbers as a server outage', () => {
    expect(classifyGitHubUnavailable('found 512 pull requests')).toBeNull()
  })
})
