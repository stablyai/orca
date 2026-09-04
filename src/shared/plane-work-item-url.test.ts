import { describe, expect, it } from 'vitest'
import type { PlaneWorkItem, PlaneWorkspace } from './plane-types'
import {
  buildPlaneWorkItemUrl,
  getMatchingPlaneWorkspaces,
  isPlaneCloudWorkItemUrl,
  isPlaneWorkItemUrl,
  isResolvedPlaneWorkItemMatch,
  parsePlaneWorkItemUrl
} from './plane-work-item-url'

const ITEM_UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const PROJECT_UUID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'

function workspace(overrides: Partial<PlaneWorkspace> = {}): PlaneWorkspace {
  return {
    id: 'ws-1',
    slug: 'acme',
    name: 'Acme',
    baseUrl: 'https://api.plane.so',
    appUrl: 'https://app.plane.so',
    ...overrides
  }
}

function workItem(overrides: Partial<PlaneWorkItem> = {}): PlaneWorkItem {
  return {
    id: ITEM_UUID,
    key: 'PROJ-123',
    sequenceId: 123,
    workspaceId: 'ws-1',
    title: 'Add OAuth login',
    url: 'https://app.plane.so/acme/browse/PROJ-123/',
    project: { id: PROJECT_UUID, identifier: 'PROJ', name: 'Platform' },
    state: { id: 's-1', name: 'Todo', group: 'unstarted' },
    labels: [],
    assignees: [],
    priority: 'high',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    ...overrides
  }
}

describe('parsePlaneWorkItemUrl', () => {
  it('parses a browse link, upper-casing the key', () => {
    expect(parsePlaneWorkItemUrl(' https://app.plane.so/acme/browse/proj-123/?tab=1#c ')).toEqual({
      workspaceSlug: 'acme',
      workItemKey: 'PROJ-123',
      projectId: null,
      workItemId: null,
      origin: 'https://app.plane.so',
      basePath: ''
    })
  })

  it('parses a self-hosted browse link mounted under a sub-path', () => {
    expect(parsePlaneWorkItemUrl('http://plane.internal:8080/tools/acme/browse/ENG-7')).toEqual({
      workspaceSlug: 'acme',
      workItemKey: 'ENG-7',
      projectId: null,
      workItemId: null,
      origin: 'http://plane.internal:8080',
      basePath: '/tools'
    })
  })

  it('parses the in-app project/issue route the address bar shows', () => {
    expect(
      parsePlaneWorkItemUrl(
        `https://app.plane.so/acme/projects/${PROJECT_UUID}/issues/${ITEM_UUID}`
      )
    ).toEqual({
      workspaceSlug: 'acme',
      workItemKey: null,
      projectId: PROJECT_UUID,
      workItemId: ITEM_UUID,
      origin: 'https://app.plane.so',
      basePath: ''
    })
  })

  it.each([
    ['not a url', 'plane'],
    ['wrong route', 'https://app.plane.so/acme/projects/'],
    ['key is not an identifier', 'https://app.plane.so/acme/browse/not-a-key-at-all'],
    ['non-uuid ids', 'https://app.plane.so/acme/projects/12/issues/34'],
    ['non-http scheme', 'ftp://app.plane.so/acme/browse/PROJ-1/'],
    ['embedded credentials', 'https://user:pw@app.plane.so/acme/browse/PROJ-1/']
  ])('rejects %s', (_label, value) => {
    expect(parsePlaneWorkItemUrl(value)).toBeNull()
    expect(isPlaneWorkItemUrl(value)).toBe(false)
  })
})

describe('buildPlaneWorkItemUrl', () => {
  it('round-trips through the parser', () => {
    const url = buildPlaneWorkItemUrl(workspace({ appUrl: 'https://app.plane.so/' }), 'PROJ-123')
    expect(url).toBe('https://app.plane.so/acme/browse/PROJ-123/')
    expect(parsePlaneWorkItemUrl(url)?.workItemKey).toBe('PROJ-123')
  })
})

describe('getMatchingPlaneWorkspaces', () => {
  const parsed = parsePlaneWorkItemUrl('https://app.plane.so/acme/browse/PROJ-123/')!

  it('matches on origin, base path and slug together', () => {
    const matches = getMatchingPlaneWorkspaces(parsed, [
      workspace(),
      workspace({ id: 'ws-2', slug: 'other' }),
      workspace({ id: 'ws-3', appUrl: 'https://plane.internal' })
    ])
    expect(matches.map((entry) => entry.id)).toEqual(['ws-1'])
  })

  it('is case-insensitive on the slug', () => {
    expect(getMatchingPlaneWorkspaces(parsed, [workspace({ slug: 'ACME' })])).toHaveLength(1)
  })
})

describe('isResolvedPlaneWorkItemMatch', () => {
  const parsed = parsePlaneWorkItemUrl('https://app.plane.so/acme/browse/PROJ-123/')!

  it('accepts a work item that round-trips to the requested url', () => {
    expect(isResolvedPlaneWorkItemMatch(parsed, workspace(), workItem())).toBe(true)
  })

  it('rejects a same-key item resolved in another workspace', () => {
    const other = workspace({ id: 'ws-2', slug: 'other' })
    expect(isResolvedPlaneWorkItemMatch(parsed, other, workItem({ workspaceId: 'ws-2' }))).toBe(
      false
    )
  })

  it('rejects a key mismatch', () => {
    expect(
      isResolvedPlaneWorkItemMatch(
        parsed,
        workspace(),
        workItem({ key: 'PROJ-124', url: 'https://app.plane.so/acme/browse/PROJ-124/' })
      )
    ).toBe(false)
  })

  it('matches the id route against the resolved work item id', () => {
    const byId = parsePlaneWorkItemUrl(
      `https://app.plane.so/acme/projects/${PROJECT_UUID}/issues/${ITEM_UUID}`
    )!
    expect(isResolvedPlaneWorkItemMatch(byId, workspace(), workItem())).toBe(true)
    expect(isResolvedPlaneWorkItemMatch(byId, workspace(), workItem({ id: PROJECT_UUID }))).toBe(
      false
    )
  })

  it('rejects a same-key item from another workspace on the same origin', () => {
    // Plane discriminates workspaces by path segment, so two workspaces on one
    // host can each own PROJ-123; the url's slug must match the workspace.
    const other = workspace({ id: 'ws-2', slug: 'other' })
    expect(
      isResolvedPlaneWorkItemMatch(
        parsed,
        other,
        workItem({ workspaceId: 'ws-2', url: 'https://app.plane.so/other/browse/PROJ-123/' })
      )
    ).toBe(false)
  })

  it('rejects a wrong-workspace item that omits workspaceId', () => {
    const other = workspace({ id: 'ws-2', slug: 'other' })
    const item = workItem({ url: 'https://app.plane.so/other/browse/PROJ-123/' })
    delete (item as { workspaceId?: string }).workspaceId
    expect(isResolvedPlaneWorkItemMatch(parsed, other, item)).toBe(false)
  })
})

describe('isPlaneCloudWorkItemUrl', () => {
  it.each(['https://app.plane.so/acme/browse/PROJ-123/', 'https://plane.so/acme/browse/PROJ-123/'])(
    'accepts the cloud host %s',
    (value) => {
      expect(isPlaneCloudWorkItemUrl(value)).toBe(true)
    }
  )

  it('rejects a self-hosted work item url, which Jira paths are indistinguishable from', () => {
    const selfHosted = 'https://plane.internal/acme/browse/PROJ-123/'
    expect(isPlaneWorkItemUrl(selfHosted)).toBe(true)
    expect(isPlaneCloudWorkItemUrl(selfHosted)).toBe(false)
  })

  it('rejects a host that merely ends in the cloud host name', () => {
    expect(isPlaneCloudWorkItemUrl('https://notplane.so/acme/browse/PROJ-1/')).toBe(false)
  })
})
