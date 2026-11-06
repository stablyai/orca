import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import WorktreeContextMenu from './WorktreeContextMenu'

const repo: Repo = {
  id: 'orca',
  path: '/preview/orca',
  displayName: 'orca',
  badgeColor: '',
  addedAt: 1
}

const worktree: Worktree = {
  id: 'orca::/preview/orca/release',
  repoId: repo.id,
  hostId: 'local',
  instanceId: 'release-instance',
  path: '/preview/orca/release',
  displayName: 'Prepare the release',
  branch: 'release',
  head: 'abc123',
  isBare: false,
  isMainWorktree: false,
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

function menuFixture(fixtureRepo: Repo, fixtureWorktree: Worktree = worktree) {
  return defineFixture({
    width: 360,
    store: {
      repos: [fixtureRepo],
      worktreesByRepo: { [fixtureRepo.id]: [fixtureWorktree] }
    },
    render: () => (
      <div className="h-[640px] bg-background p-4 text-foreground">
        <WorktreeContextMenu worktree={fixtureWorktree}>
          <div className="text-sm">Prepare the release</div>
        </WorktreeContextMenu>
      </div>
    ),
    interact: (frame) => {
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

export const open = menuFixture(repo)
export const folderProject = menuFixture({ ...repo, kind: 'folder' })
export const folderWorkspace = menuFixture(repo, { ...worktree, id: 'folder:release' })
export const recipeVm = menuFixture(
  { ...repo, connectionId: 'runtime-ssh-preview' },
  { ...worktree, hostId: 'ssh:runtime-ssh-preview' }
)
export const ssh = menuFixture(
  { ...repo, connectionId: 'preview' },
  { ...worktree, hostId: 'ssh:preview' }
)
