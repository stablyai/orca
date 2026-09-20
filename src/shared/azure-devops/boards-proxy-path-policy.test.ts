import { describe, expect, it } from 'vitest'
import { checkBoardsProxyRequest } from './boards-proxy-path-policy'

describe('checkBoardsProxyRequest', () => {
  it('allows work item and project paths, with or without a project segment', () => {
    expect(checkBoardsProxyRequest({ method: 'GET', path: '/_apis/projects' })).toBeNull()
    expect(checkBoardsProxyRequest({ method: 'POST', path: '/myproj/_apis/wit/wiql' })).toBeNull()
    expect(
      checkBoardsProxyRequest({ method: 'PATCH', path: '/_apis/wit/workitems/4821' })
    ).toBeNull()
  })

  it('refuses paths outside work items and projects', () => {
    expect(
      checkBoardsProxyRequest({ method: 'GET', path: '/_apis/git/repositories' })
    ).toMatchObject({ code: 'forbidden' })
    expect(
      checkBoardsProxyRequest({ method: 'GET', path: '/_apis/build/builds' })
    ).toMatchObject({ code: 'forbidden' })
  })

  it('refuses DELETE', () => {
    expect(
      checkBoardsProxyRequest({ method: 'DELETE', path: '/_apis/wit/workitems/1' })
    ).toMatchObject({ code: 'forbidden' })
  })

  // Each path targets ONE guard. Asserting the message, not merely "rejected",
  // means deleting a single guard cannot be masked by another catching the input.
  it.each([
    ['/_apis/wit/../git/repositories', 'path must not contain traversal segments'],
    ['https://evil.example/_apis/wit/wiql', 'path must be origin-relative'],
    ['//evil.example/_apis/wit/wiql', 'path must be origin-relative'],
    ['/_apis/wit/%2e%2e/git', 'path must not be percent-encoded'],
    ['/_apis/wit/%2F%2Fevil', 'path must not be percent-encoded'],
    ['/_apis/wit/a:b', 'path must not contain a scheme or authority'],
    ['/_apis/wit/%', 'path is not valid percent-encoding'],
    ['/_apis/wit/a\\b', 'path must not contain traversal segments']
  ])('refuses %s for its own reason', (path, message) => {
    expect(checkBoardsProxyRequest({ method: 'GET', path })).toEqual({
      code: 'validation',
      message
    })
  })

  it.each([
    ['api-version', '5.0'],
    ['API-Version', '5.0'],
    ['api-version ', '5.0'],
    [' api-version', '5.0'],
    ['api-version\t', '5.0']
  ])('refuses a caller-supplied %j query key', (key, value) => {
    expect(
      checkBoardsProxyRequest({
        method: 'GET',
        path: '/_apis/projects',
        query: { [key]: value }
      })
    ).toEqual({ code: 'validation', message: 'api-version is chosen by the host' })
  })

  it('refuses a path that does not start with a separator', () => {
    expect(checkBoardsProxyRequest({ method: 'GET', path: '_apis/projects' })).not.toBeNull()
  })
})
