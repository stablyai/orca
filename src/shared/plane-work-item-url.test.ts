import { describe, expect, it } from 'vitest'
import type { PlaneWorkspace } from './plane-types'
import {
  buildPlaneWorkItemUrl,
  isPlaneCloudWorkItemUrl,
  isPlaneWorkItemUrl,
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
