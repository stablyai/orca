import { defineFixture } from '../../../component-fixtures/component-fixture'
import { GitGraphTab } from './git-graph-tab'
import type { GitHistoryResult } from '../../../../../shared/git/history/git-history-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'

const now = Date.now()
const repo: Repo = {
  id: 'fixture-repo',
  path: '/repo',
  displayName: 'repo',
  badgeColor: '',
  addedAt: 0,
  executionHostId: 'local'
}
const current: Worktree = {
  id: 'fixture-repo::/repo',
  repoId: repo.id,
  path: '/repo',
  branch: 'refs/heads/main',
  hostId: 'local',
  head: 'a',
  isBare: false,
  isMainWorktree: true,
  displayName: 'main',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}
const workspace = (path: string, branch: string): Worktree => ({
  ...current,
  id: `${repo.id}::${path}`,
  path,
  branch: `refs/heads/${branch}`,
  isMainWorktree: false,
  displayName: branch
})
const commit = (id: string, parentIds: string[], subject: string, minutesAgo: number) => ({
  id,
  parentIds,
  subject,
  message: subject,
  author: 'Ada Lovelace',
  timestamp: now - minutesAgo * 60_000
})
const branch = (name: string) => ({ id: `refs/heads/${name}`, name })
const remote = (name: string) => ({ id: `refs/remotes/origin/${name}`, name: `origin/${name}` })
// Long names and remote copies, the case that crowds a row.
const history: GitHistoryResult = {
  items: [
    {
      ...commit('p1', ['m2'], 'docs: AI report persona plan for the USP section', 2),
      references: [
        branch('chore/ai-report-usp-persona-plan'),
        remote('chore/ai-report-usp-persona-plan')
      ]
    },
    {
      ...commit('m2', ['m1', 'f2'], 'Merge pull request #247 from acme/chore/release-2.0.0', 5),
      references: [branch('main'), branch('ada-lovelace/worktree-test'), remote('main')]
    },
    {
      ...commit('f2', ['f1'], 'docs: align the release notes with the 2.0.0 listing', 20),
      references: [branch('chore/release-2.0.0'), remote('chore/release-2.0.0')]
    },
    {
      ...commit('f1', ['m1'], 'chore: bump the extension version to 2.0.0', 30),
      // Three long local branches on one commit must still leave room for the subject.
      references: [
        branch('feat/workspace-agent-session-markers'),
        branch('fix/git-graph-narrow-pane-layout'),
        branch('chore/bump-extension-version-2.0.0')
      ]
    },
    commit('m1', [], 'Initial commit', 90)
  ],
  currentRef: branch('main'),
  hasMore: false,
  hasIncomingChanges: false,
  hasOutgoingChanges: false,
  limit: 50
}

function tab(width: number) {
  return defineFixture({
    width,
    store: {
      repos: [repo],
      worktreesByRepo: {
        [repo.id]: [
          current,
          workspace('/repo-plan', 'chore/ai-report-usp-persona-plan'),
          workspace('/repo-test', 'ada-lovelace/worktree-test')
        ]
      },
      activeWorktreeId: current.id,
      activeWorkspaceExecutionHostId: 'local'
    },
    setup: () => {
      window.api.git.history = async () => history
    },
    render: () => (
      <div className="h-52 w-full">
        <GitGraphTab worktreeId={current.id} />
      </div>
    )
  })
}

// A tab sharing the window with other panes, where the ref chips have the least room.
export const narrow = tab(980)

export const wide = tab(1400)
