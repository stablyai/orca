import { describe, expect, it } from 'vitest'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import { worktreeRefreshOptions } from './add-repo-runtime-owner'

describe('AddRepo completion owner routing', () => {
  it('routes an explicitly local completion to the local host', () => {
    expect(worktreeRefreshOptions(null)).toEqual({
      requireAuthoritative: true,
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })
  })

  it('routes an explicitly runtime completion to its captured runtime', () => {
    expect(worktreeRefreshOptions('runtime-1')).toEqual({
      requireAuthoritative: true,
      executionHostId: toRuntimeExecutionHostId('runtime-1')
    })
  })

  it('leaves an absent owner distinguishable from explicit local ownership', () => {
    expect(worktreeRefreshOptions(undefined)).toEqual({ requireAuthoritative: true })
    expect(worktreeRefreshOptions(undefined)).not.toEqual(worktreeRefreshOptions(null))
  })
})
