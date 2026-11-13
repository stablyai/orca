// PAIRED-ARCHIVE: a paired cloud workspace's own row (created on another desktop) gets the same
// cloud rows in its sidebar menu as an owned one: Restart and Archive (Unarchive once archived).
// No "Mirror to this computer": mirroring syncs this desktop's own workspaces only.
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { HostedWorkspaceStatus } from '../../../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import {
  refreshCloudWorktreeBindings,
  resetCloudWorkspaceIdentityForTests
} from '@/components/cloud-workspaces/cloud-workspace-identity'
import { seedCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import WorktreeContextMenu from './WorktreeContextMenu'

const repo: Repo = {
  id: 'cloud',
  path: '/workspace/orca-sandbox-push-test',
  displayName: 'orca-sandbox-push-test (cloud)',
  badgeColor: '',
  addedAt: 1
}

const worktree: Worktree = {
  id: 'cloud::/workspace/orca-sandbox-push-test',
  repoId: repo.id,
  hostId: 'runtime:env-paired',
  path: repo.path,
  displayName: 'master',
  branch: 'master',
  instanceId: 'main-instance',
  head: 'abc123',
  isBare: false,
  isMainWorktree: true,
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1
}

const status = (state: HostedWorkspaceStatus['state']): HostedWorkspaceStatus => ({
  state,
  metrics: null,
  uptimeMs: null,
  usage: { totalMs: 0, centsPerHour: 100, costCents: 0 },
  archive: null,
  checkedAt: 1
})

function pairedMenu(state: HostedWorkspaceStatus['state']) {
  return defineFixture({
    width: 360,
    store: { repos: [repo], worktreesByRepo: { [repo.id]: [worktree] } },
    setup: () => {
      resetCloudWorkspaceIdentityForTests()
      seedCloudWorkspaceSnapshot({
        paired: { [worktree.id]: 'env-paired' },
        idsLoaded: true,
        status: {
          [worktree.id]: {
            status: status(state),
            loading: false,
            error: null,
            fetchedAt: Date.now()
          }
        }
      })
      Object.assign(window.api.cloudWorkspaces, {
        localWorkspaces: () => Promise.resolve([]),
        environmentBindings: () => Promise.resolve({ sbx_paired: { environmentId: 'env-paired' } })
      })
      window.api.orcaCloudWorkspace = {
        ...window.api.orcaCloudWorkspace,
        getStatus: async () => ({ ok: true as const, value: status(state) })
      }
      void refreshCloudWorktreeBindings()
    },
    render: () => (
      <div className="h-[560px] bg-background p-4 text-foreground">
        <WorktreeContextMenu worktree={worktree}>
          <div className="text-sm">{worktree.displayName}</div>
        </WorktreeContextMenu>
      </div>
    ),
    interact: async (frame) => {
      await new Promise((resolve) => setTimeout(resolve, 150))
      frame.querySelector('[data-worktree-context-menu-scope]')?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 16,
          clientY: 40
        })
      )
    }
  })
}

/** Running: Restart and Archive, as on an owned row; no Mirror to this computer. */
export const pairedRunning = pairedMenu('ready')
/** Archived: Unarchive. */
export const pairedArchived = pairedMenu('archived')
