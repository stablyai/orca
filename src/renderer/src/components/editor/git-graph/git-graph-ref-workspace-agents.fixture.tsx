import { defineFixture } from '../../../component-fixtures/component-fixture'
import { GitGraphRefs } from './git-graph-ref-menu'
import { gitGraphHistoryForTab } from './git-graph-tab-controllers'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { Worktree } from '../../../../../shared/worktree/types'

const now = Date.now()
const MINUTE = 60_000
const LEAF = '11111111-1111-4111-8111-111111111111'
const worktreeId = 'fixture-repo::/repo-login'
const workspace: Worktree = {
  id: worktreeId,
  repoId: 'fixture-repo',
  path: '/repo-login',
  branch: 'refs/heads/feat/login',
  hostId: 'local',
  head: 'a',
  isBare: false,
  isMainWorktree: false,
  displayName: 'login',
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

function session(
  index: number,
  agentType: AgentStatusEntry['agentType'],
  state: AgentStatusEntry['state'],
  prompt: string,
  startedAgo: number
): { tab: TerminalTab; entry: AgentStatusEntry } {
  const tab: TerminalTab = {
    id: `fixture-login-tab-${index}`,
    ptyId: null,
    worktreeId,
    title: prompt,
    customTitle: null,
    color: null,
    sortOrder: index,
    createdAt: now
  }
  return {
    tab,
    entry: {
      paneKey: `${tab.id}:${LEAF}`,
      worktreeId,
      tabId: tab.id,
      agentType,
      state,
      prompt,
      updatedAt: now,
      stateStartedAt: now - startedAgo,
      stateHistory: []
    }
  }
}

const sessions = [
  session(0, 'claude', 'working', 'Wire the OAuth callback', 12 * MINUTE),
  session(1, 'codex', 'waiting', 'Review the login plan', 3 * MINUTE)
]
const store = {
  tabsByWorktree: { [worktreeId]: sessions.map(({ tab }) => tab) },
  agentStatusByPaneKey: Object.fromEntries(sessions.map(({ entry }) => [entry.paneKey, entry]))
}

function render() {
  return (
    <div className="flex w-full bg-background p-3 text-xs text-foreground">
      <GitGraphRefs
        controller={gitGraphHistoryForTab('fixture-repo::/repo').actions}
        support={{ supported: true, reason: undefined }}
        onCheckout={() => {}}
        onSwitch={async () => {}}
        workspaces={new Map([[workspace.branch, workspace]])}
        references={[
          { id: 'refs/heads/main', name: 'main' },
          { id: workspace.branch, name: 'feat/login' }
        ]}
        currentRefId="refs/heads/main"
      />
    </div>
  )
}

export const chip = defineFixture({ width: 320, store, render })

// A workspace without sessions keeps the plain chip.
export const noSessions = defineFixture({ width: 320, render })

export const sessionsOpen = defineFixture({
  width: 420,
  store,
  render,
  interact: async (frame) => {
    frame
      .querySelector('[data-slot="hover-card-trigger"]')
      ?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
})
