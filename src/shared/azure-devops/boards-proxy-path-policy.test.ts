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
    ['_apis/projects', 'path must be origin-relative'],
    ['/_apis/wit/%2e%2e/git', 'path must not be percent-encoded'],
    ['/_apis/wit/%2F%2Fevil', 'path must not be percent-encoded'],
    ['/_apis/wit/a:b', 'path must not contain a scheme or authority'],
    ['/_apis/wit/%', 'path is not valid percent-encoding'],
    ['/_apis/wit/a\\b', 'path must not contain traversal segments'],
    ['/_apis/wit/wiql?api-version=5.0', 'path must not contain a query or fragment'],
    ['/_apis/wit/wiql#fragment', 'path must not contain a query or fragment']
  ])('refuses %j for its own reason', (path, message) => {
    expect(checkBoardsProxyRequest({ method: 'GET', path })).toEqual({
      code: 'validation',
      message
    })
  })

  // The URL parser strips TAB, LF and CR before parsing, so each of these
  // reaches a namespace the substring guards believe they blocked. The last one
  // climbs out of the organization entirely, to stored service connections.
  it.each([
    '/_apis/wit/.\t./git/repositories',
    '/_apis/wit/.\n./build/builds',
    '/_apis/wit/.\r./release/definitions',
    '/_apis/wit/.\t./.\t./.\t./.\t./_apis/serviceendpoint/endpoints',
    '/myproj/_apis/wit/.\t./git/repositories',
    '/_apis/wit/workitems\u0000/1',
    '/_apis/wit/workitems\u007f/1'
  ])('refuses %j, which the URL parser would rewrite', (path) => {
    expect(checkBoardsProxyRequest({ method: 'GET', path })).toEqual({
      code: 'validation',
      message: 'path must not contain control characters'
    })
  })

  // The last two are the accepted cost of the equality: the parser escapes a
  // space or a non-ASCII byte, and the percent guard already blocked the
  // pre-escaped spelling, so such project names are unreachable either way.
  it.each(['/_apis/wit/a/./b', '/My Project/_apis/wit/wiql', '/Ünï/_apis/wit/wiql'])(
    'refuses %j, whose parsed form differs from the raw string',
    (path) => {
      expect(checkBoardsProxyRequest({ method: 'GET', path })).toEqual({
        code: 'forbidden',
        message: 'path is outside the Boards scope'
      })
    }
  )

  it('allows only reads on the projects namespace', () => {
    expect(checkBoardsProxyRequest({ method: 'GET', path: '/_apis/projects' })).toBeNull()
    expect(checkBoardsProxyRequest({ method: 'POST', path: '/_apis/projects' })).toEqual({
      code: 'forbidden',
      message: 'method POST is not permitted on _apis/projects'
    })
    expect(checkBoardsProxyRequest({ method: 'PATCH', path: '/_apis/projects/x' })).toEqual({
      code: 'forbidden',
      message: 'method PATCH is not permitted on _apis/projects'
    })
  })

  it('allows writes on the work item namespace', () => {
    expect(checkBoardsProxyRequest({ method: 'POST', path: '/myproj/_apis/wit/wiql' })).toBeNull()
    expect(checkBoardsProxyRequest({ method: 'PATCH', path: '/_apis/wit/workitems/1' })).toBeNull()
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
})
