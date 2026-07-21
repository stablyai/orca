import { describe, expect, it } from 'vitest'
import { classifyGitHubUnavailable, isGitHubUnavailableError } from './github-api-availability'

describe('classifyGitHubUnavailable', () => {
  it('classifies HTTP 5xx outages as server_error', () => {
    expect(classifyGitHubUnavailable('HTTP 503: Service Unavailable')).toBe('server_error')
    expect(classifyGitHubUnavailable('gh: Command failed: HTTP 502 Bad Gateway')).toBe(
      'server_error'
    )
    expect(classifyGitHubUnavailable('GitHub API error: 500 Internal Server Error')).toBe(
      'server_error'
    )
    expect(classifyGitHubUnavailable('The service is temporarily unavailable')).toBe('server_error')
  })

  it('classifies transport failures as network', () => {
    for (const message of [
      'request to https://api.github.com failed, reason: getaddrinfo ENOTFOUND api.github.com',
      'error connecting to api.github.com\ncheck your internet connection or GitHub status',
      'dial tcp: lookup api.github.com: no such host',
      'connect ETIMEDOUT 140.82.112.5:443',
      'TimeoutError: request aborted',
      'NetworkError when attempting to fetch resource',
      'network unavailable',
      'fetch failed',
      'socket hang up',
      'could not resolve host: api.github.com',
      'connection refused'
    ]) {
      expect(classifyGitHubUnavailable(message)).toBe('network')
    }
  })

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

describe('isGitHubUnavailableError', () => {
  it('detects reachability failures from Error objects and strings', () => {
    expect(isGitHubUnavailableError(new Error('HTTP 503: Service Unavailable'))).toBe(true)
    expect(isGitHubUnavailableError('fetch failed')).toBe(true)
    expect(isGitHubUnavailableError(new Error('HTTP 404: Not Found'))).toBe(false)
    expect(isGitHubUnavailableError(null)).toBe(false)
  })
})
