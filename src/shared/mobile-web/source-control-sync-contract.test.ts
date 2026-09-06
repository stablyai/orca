import { describe, expect, it } from 'vitest'
import {
  MobileWebSourceControlCheckoutPayloadSchema,
  MobileWebSourceControlPushPayloadSchema,
  MobileWebSourceControlRepositoryStateSchema,
  MobileWebSourceControlSyncResultSchema
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
  it('requires an explicit checkout confirmation and a non-option local ref', () => {
    const identity = {
      workspaceId: 'workspace-1',
      expectedHead: HEAD,
      expectedBranch: 'main'
    }
    expect(
      MobileWebSourceControlCheckoutPayloadSchema.safeParse({
        ...identity,
        branch: 'feature/mobile',
        confirmation: 'checkout-confirmed'
      }).success
    ).toBe(true)
    expect(
      MobileWebSourceControlCheckoutPayloadSchema.safeParse({
        ...identity,
        branch: '--force',
        confirmation: 'checkout-confirmed'
      }).success
    ).toBe(false)
    expect(
      MobileWebSourceControlCheckoutPayloadSchema.safeParse({
        ...identity,
        branch: 'feature/mobile'
      }).success
    ).toBe(false)
  })

  it('requires an exact bounded upstream snapshot and push confirmation', () => {
    expect(
      MobileWebSourceControlPushPayloadSchema.safeParse({
        workspaceId: 'workspace-1',
        expectedHead: HEAD,
        expectedBranch: 'main',
        expectedUpstream: upstream,
        mode: 'push',
        confirmation: 'push-confirmed'
      }).success
    ).toBe(true)
    expect(
      MobileWebSourceControlPushPayloadSchema.safeParse({
        workspaceId: 'workspace-1',
        expectedHead: HEAD,
        expectedBranch: 'main',
        expectedUpstream: { ...upstream, ahead: -1 },
        mode: 'push',
        confirmation: 'push-confirmed'
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

  it('keeps repository and action results strict and request-identifiable', () => {
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
    expect(
      MobileWebSourceControlSyncResultSchema.safeParse({
        workspaceId: 'workspace-1',
        operation: 'push',
        previousHead: HEAD,
        previousBranch: 'main',
        repository,
        completed: true
      }).success
    ).toBe(true)
    expect(
      MobileWebSourceControlSyncResultSchema.safeParse({
        workspaceId: 'workspace-1',
        operation: 'push',
        previousHead: HEAD,
        previousBranch: 'main',
        branch: 'feature/mobile',
        repository,
        completed: true
      }).success
    ).toBe(false)
  })
})
