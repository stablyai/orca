// LIFECYCLE-MATRIX: this desktop's own cloud workspace's sidebar menu, archived and asleep. Archived
// keeps only what works without a VM (Move, Unarchive, Mark Unread, Edit Details, Pin, status, Copy
// names, Delete); no Open in, SSH, Copy path or remote desktop (that lives in the tab "+" menu).
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { HostedWorkspaceStatus } from '../../../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import {
  refreshCloudWorktreeBindings,
  resetCloudWorkspaceIdentityForTests
} from '@/components/cloud-workspaces/cloud-workspace-identity'
import { seedCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import WorktreeContextMenu from './WorktreeContextMenu'
import { ConfirmationDialogProvider } from '@/components/dismiss/confirmation/confirmation-dialog'

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
  hostId: 'runtime:env-owned',
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
  archive: state === 'archived' ? { archivedAt: 1, expiresAt: Date.now() + 86_400_000 } : null,
  checkedAt: 1
})

function ownedMenu(state: HostedWorkspaceStatus['state']) {
  return defineFixture({
    width: 360,
    store: { repos: [repo], worktreesByRepo: { [repo.id]: [worktree] } },
    setup: () => {
      resetCloudWorkspaceIdentityForTests()
      seedCloudWorkspaceSnapshot({
        ids: new Set([worktree.id]),
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
        environmentBindings: () => Promise.resolve({ sbx_owned: { environmentId: 'env-owned' } })
      })
      window.api.orcaCloudWorkspace = {
        ...window.api.orcaCloudWorkspace,
        getStatus: async () => ({ ok: true as const, value: status(state) })
      }
      void refreshCloudWorktreeBindings()
    },
    render: () => (
      <div className="h-[560px] bg-background p-4 text-foreground">
        <ConfirmationDialogProvider>
          <WorktreeContextMenu worktree={worktree}>
            <div className="text-sm">{worktree.displayName}</div>
          </WorktreeContextMenu>
        </ConfirmationDialogProvider>
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

export const ownedArchived = ownedMenu('archived')
export const ownedAsleep = ownedMenu('sleeping')
