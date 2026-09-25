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
    expect(checkBoardsProxyRequest({ method: 'GET', path: '/_apis/build/builds' })).toMatchObject({
      code: 'forbidden'
    })
  })

  it('refuses a GET carrying a body as a caller error, not an opaque failure', () => {
    expect(
      checkBoardsProxyRequest({ method: 'GET', path: '/_apis/projects', body: { a: 1 } })
    ).toEqual({ code: 'validation', message: 'GET requests must not carry a body' })
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
    ['/_apis/wit/a:b', 'path must not contain a scheme or authority'],
    ['/_apis/wit/a\\b', 'path must not contain traversal segments'],
    ['/_apis/wit/wiql?api-version=5.0', 'path must not contain a query or fragment'],
    ['/_apis/wit/wiql#fragment', 'path must not contain a query or fragment'],
    // Pins the raw pass: without it the malformed '%' would answer first and a
    // traversal would be reported as an encoding problem.
    ['/_apis/wit/../%zz', 'path must not contain traversal segments']
  ])('refuses %j for its own reason', (path, message) => {
    expect(checkBoardsProxyRequest({ method: 'GET', path })).toEqual({
      code: 'validation',
      message
    })
  })

  // Work item types are addressed by name and have no GUID form, so the default
  // process templates are unreachable unless an encoded space is allowed.
  it.each([
    ['GET', '/p/_apis/wit/workitemtypes/User%20Story'],
    ['GET', '/p/_apis/wit/workitemtypes/User%20Story/states'],
    ['GET', '/p/_apis/wit/workitemtypes/User%20Story/fields'],
    ['GET', '/_apis/wit/workitemtypes/Bug/states'],
    ['POST', '/p/_apis/wit/workitems/$User%20Story'],
    ['POST', '/p/_apis/wit/workitems/$Bug'],
    ['GET', '/My%20Project/_apis/wit/wiql']
  ])('allows %s %j', (method, path) => {
    expect(checkBoardsProxyRequest({ method, path })).toBeNull()
  })

  // An encoded separator is not an escape: it can only land deeper inside the
  // namespace the caller was already granted.
  it('allows an encoded separator that stays inside the namespace', () => {
    expect(checkBoardsProxyRequest({ method: 'GET', path: '/_apis/wit/%2F%2Fevil' })).toBeNull()
  })

  // Every spelling of a dot segment, in both cases and at both encoding depths.
  it.each([
    ['/_apis/wit/%2e%2e/git/repositories', 'path must not contain traversal segments'],
    ['/_apis/wit/%2E%2E/git/repositories', 'path must not contain traversal segments'],
    ['/_apis/wit/%2e%2e%2fgit', 'path must not contain traversal segments'],
    ['/_apis/wit/%252e%252e/git', 'path must not be double percent-encoded'],
    ['/_apis/wit/.%09./git/repositories', 'path must not contain control characters'],
    ['/_apis/wit/a%3Ab', 'path must not contain a scheme or authority'],
    ['/_apis/wit/a%5Cb', 'path must not contain traversal segments'],
    ['/_apis/wit/%', 'path is not valid percent-encoding'],
    ['/_apis/wit/%zz', 'path is not valid percent-encoding'],
    ['/_apis/wit/%C0%AF', 'path is not valid percent-encoding']
  ])('refuses the encoded form %j', (path, message) => {
    expect(checkBoardsProxyRequest({ method: 'GET', path })).toEqual({
      code: 'validation',
      message
    })
  })

  // The namespace is matched on both forms. The raw path is what gets sent, so
  // an encoded separator may neither widen the project segment nor be the only
  // thing that puts the path in scope.
  it.each(['/a%2Fb/_apis/wit/workitems', '/_apis%2Fwit/workitems'])(
    'refuses %j, whose two forms disagree about the namespace',
    (path) => {
      expect(checkBoardsProxyRequest({ method: 'GET', path })).toEqual({
        code: 'forbidden',
        message: 'path is outside the Boards scope'
      })
    }
  )

  // $batch carries its own {method, uri} sub-requests, which no guard here sees.
  it.each([
    ['POST', '/_apis/wit/$batch'],
    ['POST', '/p/_apis/wit/$batch'],
    ['POST', '/p/_apis/wit/$BATCH'],
    ['POST', '/_apis/wit/%24batch'],
    ['POST', '/_apis/wit/$batch/'],
    ['POST', '/_apis/wit/$batch/x'],
    ['GET', '/_apis/wit/$batch']
  ])('refuses %s %j', (method, path) => {
    expect(checkBoardsProxyRequest({ method, path })).toEqual({
      code: 'forbidden',
      message: 'batch requests are not permitted because their sub-request URIs are not reviewable'
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

  // The parser escapes a raw space or non-ASCII byte, so the equality fails.
  // Callers send the encoded spelling instead; those are asserted as allowed above.
  it.each([
    '/_apis/wit/a/./b',
    '/My Project/_apis/wit/wiql',
    '/Ünï/_apis/wit/wiql',
    '/p/_apis/wit/workitemtypes/User Story',
    '/p/_apis/wit/workitemtypes/User Story/states'
  ])('refuses %j, whose parsed form differs from the raw string', (path) => {
    expect(checkBoardsProxyRequest({ method: 'GET', path })).toEqual({
      code: 'forbidden',
      message: 'path is outside the Boards scope'
    })
  })

  it('refuses a raw space in the create form', () => {
    expect(
      checkBoardsProxyRequest({ method: 'POST', path: '/p/_apis/wit/workitems/$User Story' })
    ).toEqual({ code: 'forbidden', message: 'path is outside the Boards scope' })
  })

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

describe('write routes within the wit namespace', () => {
  const allow = (method: string, path: string) =>
    expect(checkBoardsProxyRequest({ method, path, body: {} })).toBeNull()
  const refuse = (method: string, path: string) =>
    expect(checkBoardsProxyRequest({ method, path, body: {} })).toEqual({
      code: 'forbidden',
      message: `method ${method} is not permitted on this _apis/wit route`
    })

  it('permits the writes the Boards source actually makes', () => {
    allow('POST', '/_apis/wit/wiql')
    allow('POST', '/proj/_apis/wit/wiql')
    allow('POST', '/proj/_apis/wit/workitems/$Bug')
    allow('POST', '/proj/_apis/wit/workitems/$User%20Story')
    allow('POST', '/proj/_apis/wit/workItems/41/comments')
    allow('PATCH', '/_apis/wit/workitems/41')
  })

  it('refuses a write that reshapes Boards metadata', () => {
    // Both are documented mutating endpoints inside the same namespace.
    refuse('POST', '/proj/_apis/wit/classificationnodes/Areas')
    refuse('POST', '/proj/_apis/wit/classificationnodes/Iterations')
    refuse('PATCH', '/proj/_apis/wit/classificationnodes/Areas')
  })

  it('refuses a write to stored queries', () => {
    refuse('POST', '/proj/_apis/wit/queries/Shared%20Queries')
    refuse('PATCH', '/proj/_apis/wit/queries/abc')
  })

  it('refuses a work item write that names no type or id', () => {
    refuse('POST', '/proj/_apis/wit/workitems')
    refuse('PATCH', '/_apis/wit/workitems')
    refuse('POST', '/_apis/wit/workitems/41')
  })

  it('leaves reads namespace-wide', () => {
    expect(
      checkBoardsProxyRequest({ method: 'GET', path: '/proj/_apis/wit/classificationnodes/Iterations' })
    ).toBeNull()
    expect(checkBoardsProxyRequest({ method: 'GET', path: '/proj/_apis/wit/workitemtypes' })).toBeNull()
  })
})
