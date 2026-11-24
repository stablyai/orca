import { defineFixture } from '../../component-fixtures/component-fixture'
import type { AgentSessionContinuationRequest } from '../../../../shared/agent-session/conversation-context/agent-session-continuation'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { AgentSessionContinuationDialog } from './AgentSessionContinuationDialog'

const repo: Repo = {
  id: 'orca',
  path: '/Users/me/orca',
  displayName: 'orca',
  badgeColor: '',
  addedAt: 1
}

const worktree: Worktree = {
  id: 'orca::/Users/me/orca/workspaces/fix-login',
  repoId: repo.id,
  path: '/Users/me/orca/workspaces/fix-login',
  displayName: 'fix-login',
  branch: 'fix-login',
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

const request: AgentSessionContinuationRequest = {
  source: {
    sourceAgent: 'claude',
    capturedText: 'Fixed the login redirect; tests pass except the SSO case.',
    sourceTitle: 'Fix login redirect',
    lastPrompt: 'Make the login redirect keep the return URL.',
    lastAssistantMessage: 'Fixed the login redirect; tests pass except the SSO case.'
  },
  worktreeId: worktree.id,
  workspacePath: worktree.path,
  launchSource: 'sidebar'
}

export const handoff = defineFixture({
  width: 640,
  store: { repos: [repo], worktreesByRepo: { [repo.id]: [worktree] } },
  render: () => (
    <div className="h-[460px] bg-background">
      <AgentSessionContinuationDialog open request={request} onOpenChange={() => {}} />
    </div>
  )
})
