import { describe, expect, it } from 'vitest'
import type { MultiRepoWorkspace } from '../../../shared/multi-repo-workspace'
import { resolveMultiRepoExecutionHostId } from './multi-repo-execution-host'

const multiRepo: MultiRepoWorkspace = {
  version: 1,
  executionHostId: 'local',
  rootOwnedByOrca: true,
  members: []
}

describe('resolveMultiRepoExecutionHostId', () => {
  it('prefers the host adoption stamped on the workspace', () => {
    expect(resolveMultiRepoExecutionHostId({ executionHostId: 'runtime:env-a', multiRepo })).toBe(
      'runtime:env-a'
    )
  })

  it('falls back to the multi-repo host when the workspace carries no stamp', () => {
    expect(resolveMultiRepoExecutionHostId({ multiRepo })).toBe('local')
    expect(resolveMultiRepoExecutionHostId({ executionHostId: null, multiRepo })).toBe('local')
  })

  it('is undefined for a workspace that is not multi-repo and has no stamp', () => {
    expect(resolveMultiRepoExecutionHostId({})).toBeUndefined()
  })
})
