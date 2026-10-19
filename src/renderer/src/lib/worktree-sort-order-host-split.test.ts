import { describe, expect, it } from 'vitest'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'
import { splitWorktreeSortOrderByHost } from './worktree-sort-order-host-split'

const state: WorktreeRuntimeOwnerState = {
  settings: { activeRuntimeEnvironmentId: 'focused-env' },
  repos: [
    { id: 'local-repo', connectionId: null, executionHostId: 'local' },
    { id: 'runtime-repo', connectionId: null, executionHostId: 'runtime:env-1' }
  ],
  worktreesByRepo: {
    'local-repo': [{ id: 'local-repo::wt-a', repoId: 'local-repo' }],
    'runtime-repo': [{ id: 'runtime-repo::wt-b', repoId: 'runtime-repo' }]
  }
}

describe('splitWorktreeSortOrderByHost', () => {
  it('groups worktree ids by owner host, preserving relative order', () => {
    const groups = splitWorktreeSortOrderByHost(state, ['runtime-repo::wt-b', 'local-repo::wt-a'])
    expect(groups).toEqual([
      { hostId: 'runtime:env-1', orderedIds: ['runtime-repo::wt-b'] },
      { hostId: 'local', orderedIds: ['local-repo::wt-a'] }
    ])
  })

  it('routes legacy worktrees without an explicit owner to the focused host', () => {
    const groups = splitWorktreeSortOrderByHost(
      {
        settings: { activeRuntimeEnvironmentId: 'focused-env' },
        repos: [{ id: 'legacy', connectionId: null, executionHostId: null }],
        worktreesByRepo: { legacy: [{ id: 'legacy::wt', repoId: 'legacy' }] }
      },
      ['legacy::wt']
    )
    expect(groups).toEqual([{ hostId: 'runtime:focused-env', orderedIds: ['legacy::wt'] }])
  })

  it('leaves out a twin and a row only a repo row places on a server', () => {
    const groups = splitWorktreeSortOrderByHost(
      {
        settings: { activeRuntimeEnvironmentId: null },
        runtimeEnvironments: [{ id: 'hub-env' }],
        runtimeEnvironmentCatalogHydrated: true,
        repos: [
          { id: 'local-repo', connectionId: null, executionHostId: 'local' },
          { id: 'twin', connectionId: null, executionHostId: 'local' },
          { id: 'twin', connectionId: 'box', executionHostId: 'ssh:box' },
          { id: 'stale-hub', connectionId: 'target', executionHostId: 'runtime:hub-env' },
          { id: 'hub', connectionId: 'box', executionHostId: 'runtime:hub-env' }
        ],
        worktreesByRepo: {
          'local-repo': [{ id: 'local-repo::wt-a', repoId: 'local-repo' }],
          twin: [
            { id: 'twin::wt', repoId: 'twin', hostId: 'local' },
            { id: 'twin::wt', repoId: 'twin', hostId: 'ssh:box' }
          ],
          'stale-hub': [{ id: 'stale-hub::wt', repoId: 'stale-hub', hostId: 'ssh:target' }],
          hub: [
            {
              id: 'hub::wt',
              repoId: 'hub',
              hostId: 'ssh:box',
              runtimeOwnerEnvironmentId: 'hub-env'
            }
          ]
        }
      },
      ['twin::wt', 'stale-hub::wt', 'hub::wt', 'local-repo::wt-a']
    )
    expect(groups).toEqual([
      { hostId: 'runtime:hub-env', orderedIds: ['hub::wt'] },
      { hostId: 'local', orderedIds: ['local-repo::wt-a'] }
    ])
  })
})
