import { describe, expect, it } from 'vitest'
import { buildPlaneConnectArgs } from './plane-connect-args'

describe('buildPlaneConnectArgs', () => {
  it('uses Plane Cloud API defaults', () => {
    expect(
      buildPlaneConnectArgs({
        selfHosted: false,
        baseUrl: '',
        workspaceSlug: ' acme ',
        apiToken: ' token '
      })
    ).toEqual({
      baseUrl: 'https://api.plane.so',
      workspaceSlug: 'acme',
      apiToken: 'token'
    })
  })

  it('uses the self-hosted origin for API and app links', () => {
    expect(
      buildPlaneConnectArgs({
        selfHosted: true,
        baseUrl: ' https://plane.example.com ',
        workspaceSlug: 'acme',
        apiToken: 'token'
      })
    ).toEqual({
      baseUrl: 'https://plane.example.com',
      appUrl: 'https://plane.example.com',
      workspaceSlug: 'acme',
      apiToken: 'token'
    })
  })
})
