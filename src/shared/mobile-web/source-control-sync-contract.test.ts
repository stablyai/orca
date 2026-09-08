import { describe, expect, it } from 'vitest'
import {
  MobileWebSourceControlCheckoutPayloadSchema,
  MobileWebSourceControlPushPayloadSchema,
  MobileWebSourceControlRepositoryStateSchema
} from './source-control-sync-contract'

const HEAD = 'a'.repeat(40)
const upstream = {
  hasUpstream: true,
  upstreamName: 'origin/main',
  ahead: 2,
  behind: 1,
  hasConfiguredPushTarget: false,
  behindCommitsArePatchEquivalent: false
}

describe('mobile web source-control sync contract', () => {
  it('requires a non-option local ref to check out', () => {
    expect(
      MobileWebSourceControlCheckoutPayloadSchema.safeParse({
        workspaceId: 'workspace-1',
        branch: 'feature/mobile'
      }).success
    ).toBe(true)
    expect(
      MobileWebSourceControlCheckoutPayloadSchema.safeParse({
        workspaceId: 'workspace-1',
        branch: '--force'
      }).success
    ).toBe(false)
  })

  it('carries only the push mode the Desktop reauthorizes', () => {
    expect(
      MobileWebSourceControlPushPayloadSchema.safeParse({
        workspaceId: 'workspace-1',
        mode: 'publish'
      }).success
    ).toBe(true)
    expect(
      MobileWebSourceControlPushPayloadSchema.safeParse({
        workspaceId: 'workspace-1',
        mode: 'push',
        forceWithLease: true
      }).success
    ).toBe(false)
  })

  it('rejects upstream names that could expose a host path or URL', () => {
    for (const upstreamName of [
      '/private/repository',
      String.raw`C:\private\repository`,
      String.raw`origin\main`,
      'ssh://host/repository'
    ]) {
      expect(
        MobileWebSourceControlRepositoryStateSchema.safeParse({
          workspaceId: 'workspace-1',
          head: HEAD,
          branch: 'main',
          conflictOperation: 'unknown',
          baseRef: 'origin/main',
          upstream: { ...upstream, upstreamName }
        }).success
      ).toBe(false)
    }
  })

  it('keeps the repository state strict', () => {
    const repository = {
      workspaceId: 'workspace-1',
      head: HEAD,
      branch: 'main',
      conflictOperation: 'unknown',
      baseRef: 'origin/main',
      upstream
    }
    expect(MobileWebSourceControlRepositoryStateSchema.parse(repository)).toEqual(repository)
    expect(
      MobileWebSourceControlRepositoryStateSchema.safeParse({
        ...repository,
        hostPath: '/private/repository'
      }).success
    ).toBe(false)
  })
})
