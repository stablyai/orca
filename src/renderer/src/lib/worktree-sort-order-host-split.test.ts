import { describe, expect, it } from 'vitest'

import { splitWorktreeSortOrderByHost } from './worktree-sort-order-host-split'

describe('splitWorktreeSortOrderByHost', () => {
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
      { hostId: 'runtime:hub-env', orderedIds: ['hub::wt'], rowHostIds: ['ssh:box'] },
      { hostId: 'local', orderedIds: ['local-repo::wt-a'], rowHostIds: ['local'] }
    ])
  })
})
