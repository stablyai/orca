import { describe, expect, it } from 'vitest'
import { createFileSearchResultOwner } from './file-search-result-owner'

describe('createFileSearchResultOwner', () => {
  it('captures the exact runtime used by the completed search', () => {
    const settings = { activeRuntimeEnvironmentId: ' runtime-owner-a ' }
    const owner = createFileSearchResultOwner('worktree-a', settings)
    settings.activeRuntimeEnvironmentId = 'runtime-owner-b'

    expect(owner).toEqual({
      worktreeId: 'worktree-a',
      runtimeEnvironmentId: 'runtime-owner-a'
    })
  })

  it.each([null, '', '   '])('records %j as an explicit non-runtime owner', (environmentId) => {
    expect(
      createFileSearchResultOwner('local-or-ssh-worktree', {
        activeRuntimeEnvironmentId: environmentId
      })
    ).toEqual({
      worktreeId: 'local-or-ssh-worktree',
      runtimeEnvironmentId: null
    })
  })
})
