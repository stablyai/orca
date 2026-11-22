import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import WorktreeCard from './WorktreeCard'

const repo: Repo = {
  id: 'bot-line-preview',
  path: '/preview/orca',
  displayName: 'orca',
  badgeColor: '',
  addedAt: 1
}
function worktree(id: string, displayName: string, repoId = repo.id): Worktree {
  return {
    id,
    displayName,
    repoId,
    path: `/preview/orca/${id}`,
    branch: id,
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
}

export const botWorkerLines = defineFixture({
  width: 300,
  render: () => (
    <div className="flex flex-col gap-0.5 bg-worktree-sidebar p-2 text-worktree-sidebar-foreground">
      <WorktreeCard
        worktree={worktree('triage', 'Triage new issues')}
        repo={repo}
        isActive={false}
        compactLine
      />
      <WorktreeCard
        worktree={worktree('release-notes', 'Draft release notes')}
        repo={repo}
        isActive={false}
        compactLine
      />
    </div>
  )
})
