import { describe, expect, it } from 'vitest'
import { hostRepoCatalogSnapshotFromRepoList } from './host-repo-catalog-snapshot'

describe('hostRepoCatalogSnapshotFromRepoList', () => {
  it('retains isPinned only when true so stopped WSL projects keep their pinned tier on cold boot', () => {
    const snapshot = hostRepoCatalogSnapshotFromRepoList({
      repos: [
        {
          id: 'pinned-wsl',
          path: '/home/me/pinned',
          displayName: 'Pinned',
          badgeColor: '#22c55e',
          addedAt: 10,
          kind: 'git',
          isPinned: true
        },
        {
          id: 'unpinned-wsl',
          path: '/home/me/unpinned',
          displayName: 'Unpinned',
          badgeColor: '#737373',
          addedAt: 20,
          isPinned: false
        }
      ]
    })

    expect(snapshot).toEqual({
      repos: [
        {
          id: 'pinned-wsl',
          path: '/home/me/pinned',
          displayName: 'Pinned',
          badgeColor: '#22c55e',
          addedAt: 10,
          kind: 'git',
          isPinned: true
        },
        {
          id: 'unpinned-wsl',
          path: '/home/me/unpinned',
          displayName: 'Unpinned',
          badgeColor: '#737373',
          addedAt: 20
        }
      ]
    })
  })
})
