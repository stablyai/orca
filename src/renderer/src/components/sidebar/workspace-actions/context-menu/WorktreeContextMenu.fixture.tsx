import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
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

const childWorktree: Worktree = {
  ...worktree,
  id: 'orca::/preview/orca/release-notes',
  instanceId: 'release-notes-instance',
  path: '/preview/orca/release-notes',
  displayName: 'Write release notes',
  branch: 'release-notes'
}

function menuFixture(
  fixtureRepo: Repo,
  fixtureWorktree: Worktree = worktree,
  extra: { children?: Worktree[]; projectGroups?: ProjectGroup[] } = {}
) {
  const children = extra.children ?? []
  return defineFixture({
    width: extra.projectGroups ? 720 : 360,
    store: {
      repos: [fixtureRepo],
      projectGroups: extra.projectGroups ?? [],
      worktreesByRepo: { [fixtureRepo.id]: [fixtureWorktree, ...children] },
      worktreeLineageById: Object.fromEntries(
        children.map((child) => [
          child.id,
          {
            worktreeId: child.id,
            worktreeInstanceId: child.instanceId ?? '',
            parentWorktreeId: fixtureWorktree.id,
            parentWorktreeInstanceId: fixtureWorktree.instanceId ?? '',
            origin: 'manual' as const,
            capture: { source: 'manual-action' as const, confidence: 'explicit' as const },
            createdAt: 1
          }
        ])
      )
    },
    render: () => (
      <div className="h-[640px] bg-background p-4 text-foreground">
        <WorktreeContextMenu worktree={fixtureWorktree}>
          <div className="text-sm">Prepare the release</div>
        </WorktreeContextMenu>
      </div>
    ),
    interact: async (frame) => {
      frame.querySelector('[data-worktree-context-menu-scope]')?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 16,
          clientY: 40
        })
      )
      if (extra.projectGroups) {
        await new Promise(requestAnimationFrame)
        const trigger = Array.from(
          frame.ownerDocument.querySelectorAll<HTMLElement>(
            '[data-slot="dropdown-menu-sub-trigger"]'
          )
        ).find((item) => item.textContent === 'Project Group')
        trigger?.focus()
        trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      }
    }
  })
}

export const open = menuFixture(repo)
export const withChild = menuFixture(repo, worktree, { children: [childWorktree] })
const projectGroups: ProjectGroup[] = ['Releases', 'Experiments'].map((name, index) => ({
  id: name.toLowerCase(),
  name,
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: index,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}))
export const groupedProject = menuFixture({ ...repo, projectGroupId: 'releases' }, worktree, {
  projectGroups
})
export const ungroupedProject = menuFixture(repo, worktree, { projectGroups })
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
