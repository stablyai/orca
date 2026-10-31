import { defineFixture } from '../../component-fixtures/component-fixture'
import { RelayedRuntimeHostsList } from './RelayedRuntimeHostsSection'
import type { RelayedRuntimeHostOwner } from '@/runtime/relayed-runtime-hosts'

// The section sits under the workspace list at the default sidebar width; an auto-height frame lifts its 40% cap.
const SIDEBAR_WIDTH = 280

const owners: RelayedRuntimeHostOwner[] = [
  {
    environmentId: 'env-a',
    pairingRevision: 1,
    label: 'Studio Mac',
    state: 'listed',
    hosts: [
      {
        hostId: 'runtime:vm-1',
        label: 'feature-auth VM',
        worktrees: [
          {
            worktreeId: 'repo-1::/srv/orca/auth',
            displayName: '',
            branch: 'refs/heads/feature/auth-tokens',
            repo: 'orca',
            workspaceKind: 'git'
          },
          {
            worktreeId: 'repo-1::/srv/orca/main',
            displayName: 'Release prep',
            branch: 'refs/heads/release/1.4',
            repo: 'orca',
            workspaceKind: 'git'
          }
        ]
      },
      {
        hostId: 'runtime:vm-2',
        label: 'docs VM',
        worktrees: [
          {
            worktreeId: 'folder-1',
            displayName: 'Design notes',
            branch: '',
            repo: 'notes',
            workspaceKind: 'folder-workspace'
          }
        ]
      },
      { hostId: 'runtime:vm-3', label: 'gpu VM', worktrees: null }
    ]
  },
  { environmentId: 'env-b', pairingRevision: 1, label: 'Build box', state: 'unavailable' }
]

export const listed = defineFixture({
  width: SIDEBAR_WIDTH,
  render: () => (
    <div className="bg-worktree-sidebar">
      <RelayedRuntimeHostsList owners={owners} />
    </div>
  )
})

export const empty = defineFixture({
  width: SIDEBAR_WIDTH,
  render: () => (
    <div className="bg-worktree-sidebar">
      <RelayedRuntimeHostsList owners={[]} />
    </div>
  )
})

// No server listed: the "later update" note has nothing to refer to, so it stays hidden.
export const unreadable = defineFixture({
  width: SIDEBAR_WIDTH,
  render: () => (
    <div className="bg-worktree-sidebar">
      <RelayedRuntimeHostsList owners={owners.slice(1)} />
    </div>
  )
})
