import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/types'
import { splitRepoReorderByHost } from './repo-reorder-host-split'

function repo(id: string, executionHostId: string | null): Repo {
  return { id, executionHostId, connectionId: null } as unknown as Repo
}

describe('splitRepoReorderByHost', () => {
  it('groups ids by owner host, preserving relative order', () => {
    const repos = [
      repo('local-a', 'local'),
      repo('runtime-a', 'runtime:env-1'),
      repo('local-b', 'local'),
      repo('runtime-b', 'runtime:env-1')
    ]
    const groups = splitRepoReorderByHost(['runtime-a', 'local-a', 'runtime-b', 'local-b'], repos, {
      activeRuntimeEnvironmentId: null
    })
    expect(groups).toEqual([
      { hostId: 'runtime:env-1', orderedIds: ['runtime-a', 'runtime-b'] },
      { hostId: 'local', orderedIds: ['local-a', 'local-b'] }
    ])
  })

  it('falls back to the focused host for repos without an explicit owner', () => {
    const groups = splitRepoReorderByHost(['a', 'b'], [repo('a', null), repo('b', null)], {
      activeRuntimeEnvironmentId: 'focused-env'
    })
    expect(groups).toEqual([{ hostId: 'runtime:focused-env', orderedIds: ['a', 'b'] }])
  })

  it('treats unowned repos as local when no runtime is focused', () => {
    const groups = splitRepoReorderByHost(['a', 'b'], [repo('a', null), repo('b', null)], {
      activeRuntimeEnvironmentId: null
    })
    expect(groups).toEqual([{ hostId: 'local', orderedIds: ['a', 'b'] }])
  })

  it('ignores ids that no longer map to a repo', () => {
    const groups = splitRepoReorderByHost(['a', 'gone'], [repo('a', 'local')], {
      activeRuntimeEnvironmentId: null
    })
    expect(groups).toEqual([{ hostId: 'local', orderedIds: ['a'] }])
  })
})
