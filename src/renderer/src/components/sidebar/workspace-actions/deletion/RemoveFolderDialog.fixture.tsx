import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import RemoveFolderDialog from './RemoveFolderDialog'

const repo: Repo = {
  id: 'orca',
  path: '/Users/me/orca/orca',
  displayName: 'orca',
  badgeColor: '',
  addedAt: 1
}

const mainWorktree: Worktree = {
  id: 'orca::/Users/me/orca/orca',
  repoId: repo.id,
  path: '/Users/me/orca/orca',
  displayName: 'orca',
  branch: 'main',
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

function linkedWorktree(name: string): Worktree {
  const path = `/Users/me/orca/workspaces/orca/${name}`
  return {
    ...mainWorktree,
    id: `orca::${path}`,
    path,
    displayName: name,
    branch: name,
    isMainWorktree: false
  }
}

function dialogFixture(linkedNames: readonly string[]) {
  return defineFixture({
    width: 640,
    store: {
      activeModal: 'confirm-remove-folder',
      modalData: { repoId: repo.id, displayName: repo.displayName, hostId: 'local' },
      repos: [repo],
      worktreesByRepo: { [repo.id]: [mainWorktree, ...linkedNames.map(linkedWorktree)] }
    },
    render: () => (
      <div className="h-[300px] bg-background">
        <RemoveFolderDialog />
      </div>
    )
  })
}

export const noWorkspaces = dialogFixture([])

export const oneWorkspace = dialogFixture(['fix-login'])

export const severalWorkspaces = dialogFixture(['fix-login', 'docs-refresh', 'perf-sweep'])
