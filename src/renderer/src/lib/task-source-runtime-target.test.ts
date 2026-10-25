import { describe, expect, it } from 'vitest'
import { UNRESOLVED_OWNER_HOST_ID } from '../../../shared/execution-host'
import { taskSourceRuntimeTarget } from './task-source-runtime-target'
import { projectViewCacheKey, projectViewCacheKeyTarget } from '@/store/github/cache-identity'

describe('row-less source transports', () => {
  it('reads a task source from its own host', () => {
    expect(taskSourceRuntimeTarget({ hostId: 'runtime:env-a' })).toEqual({
      kind: 'environment',
      environmentId: 'env-a'
    })
    expect(taskSourceRuntimeTarget({ hostId: 'local' })).toEqual({ kind: 'local' })
    expect(taskSourceRuntimeTarget(null)).toEqual({ kind: 'local' })
  })

  it('keeps an unresolved source host remote so the call fails instead of running locally', () => {
    expect(taskSourceRuntimeTarget({ hostId: UNRESOLVED_OWNER_HOST_ID })).toEqual({
      kind: 'environment',
      environmentId: 'unresolved-owner'
    })
  })

  it('reads a board row back from the host written into its cache key', () => {
    expect(
      projectViewCacheKeyTarget(
        projectViewCacheKey('organization', 'acme', 1, 'view', undefined, 'runtime:env-b')
      )
    ).toEqual({
      kind: 'environment',
      environmentId: 'env-b'
    })
    expect(
      projectViewCacheKeyTarget(
        projectViewCacheKey('organization', 'acme', 1, 'view', undefined, 'local')
      )
    ).toEqual({
      kind: 'local'
    })
  })
})
