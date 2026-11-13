// CLOUD-PRIMARY-DELETE: a cloud workspace on its repo's default branch (the sandbox's own checkout,
// here paired from another desktop) gets an enabled "Delete workspace…", with no primary-worktree
// note and no "Remove Project". A local primary checkout keeps upstream's rule, unchanged.
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  refreshCloudWorktreeBindings,
  resetCloudWorkspaceIdentityForTests
} from '@/components/cloud-workspaces/cloud-workspace-identity'
import WorktreeContextMenu from './WorktreeContextMenu'

const base: Omit<Worktree, 'id' | 'repoId' | 'hostId' | 'path' | 'displayName' | 'branch'> = {
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

function primaryMenu(repo: Repo, worktree: Worktree, pairedEnvironmentId?: string) {
  return defineFixture({
    width: 360,
    store: { repos: [repo], worktreesByRepo: { [repo.id]: [worktree] } },
    setup: () => {
      resetCloudWorkspaceIdentityForTests()
      Object.assign(window.api.cloudWorkspaces, {
        localWorkspaces: () => Promise.resolve([]),
        environmentBindings: () =>
          Promise.resolve(
            pairedEnvironmentId ? { sbx_paired: { environmentId: pairedEnvironmentId } } : {}
          )
      })
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

/** Paired cloud workspace on `main`: Delete workspace…, enabled; no "primary" rule, no Remove Project. */
export const cloudDefaultBranch = primaryMenu(
  {
    id: 'cloud',
    path: '/workspace/orca-private',
    displayName: 'orca-private (cloud)',
    badgeColor: '',
    addedAt: 1
  },
  {
    ...base,
    id: 'cloud::/workspace/orca-private',
    repoId: 'cloud',
    hostId: 'runtime:env-cloud',
    path: '/workspace/orca-private',
    displayName: 'main',
    branch: 'main'
  },
  'env-cloud'
)

/** A local repo's primary checkout: upstream's disabled Delete Worktree and Remove Project, unchanged. */
export const localPrimary = primaryMenu(
  { id: 'orca', path: '/preview/orca', displayName: 'orca', badgeColor: '', addedAt: 1 },
  {
    ...base,
    id: 'orca::/preview/orca',
    repoId: 'orca',
    hostId: 'local',
    path: '/preview/orca',
    displayName: 'main',
    branch: 'main'
  }
)
