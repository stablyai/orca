// Right-click on a workspace card's agent row vs its own header: the agent row's menu has no Delete.
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { ConfirmationDialogProvider } from '../../../dismiss/confirmation/confirmation-dialog'
import { structuredAgentSessionPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { WORKSPACE_AGENT_ROW_ATTR } from '../../workspace-actions/context-menu/workspace-agent-row-marker'
import { seedWorktreeAgentExpansionStateForTests } from '../activity/worktree-card-agents-expansion-state'
import WorktreeCard from './WorktreeCard'

const now = 1_792_983_600_000
const repo: Repo = {
  id: 'shop',
  path: '/preview/shop',
  displayName: 'shop',
  badgeColor: '',
  addedAt: 1
}
const worktree: Worktree = {
  id: 'shop::/preview/shop/payoption_opt',
  repoId: repo.id,
  hostId: 'local',
  instanceId: 'payoption-instance',
  path: '/preview/shop/payoption_opt',
  displayName: 'payoption_opt',
  branch: 'payoption_opt',
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
  lastActivityAt: now
}
const tabs: Tab[] = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222'
].map((entityId, index) => ({
  id: `agent-tab-${index}`,
  entityId,
  contentType: 'agent-session',
  agentSessionAgent: 'codex',
  worktreeId: worktree.id,
  groupId: 'fixture-group',
  executionHostId: 'local',
  label: 'Chat',
  customLabel: null,
  color: null,
  sortOrder: index,
  createdAt: now
}))
const entries: AgentStatusEntry[] = tabs.map((tab, index) => ({
  paneKey: structuredAgentSessionPaneKey(tab.id, tab.entityId),
  worktreeId: worktree.id,
  agentType: 'codex',
  state: index === 0 ? 'working' : 'done',
  prompt: index === 0 ? 'Compare the payment channels' : 'Continue work from the last plan',
  updatedAt: now,
  stateStartedAt: now,
  stateHistory: []
}))

type From = 'agent-row' | 'header' | 'expander'

function menuFrom(
  from: From,
  mode: 'compact' | 'full',
  card: { isActive?: boolean; isMultiSelected?: boolean } = {}
) {
  return defineFixture({
    width: 380,
    store: {
      repos: [repo],
      worktreesByRepo: { [repo.id]: [worktree] },
      agentActivityDisplayMode: mode,
      unifiedTabsByWorktree: { [worktree.id]: tabs },
      agentStatusByPaneKey: acceptedAgentStatuses(entries.map((entry) => [entry.paneKey, entry]))
    },
    // The agent list starts open, so each agent has its own row to right-click.
    setup: () =>
      seedWorktreeAgentExpansionStateForTests(worktree.id, {
        expandedLineageParents: new Set(),
        expandedIdleChildGroups: new Set(),
        compactRootListExpanded: true
      }),
    render: () => (
      <ConfirmationDialogProvider>
        <div className="h-[560px] bg-worktree-sidebar p-2 text-worktree-sidebar-foreground">
          <WorktreeCard
            worktree={worktree}
            repo={repo}
            isActive={card.isActive ?? false}
            isMultiSelected={card.isMultiSelected ?? false}
            nativeDragEnabled={false}
          />
        </div>
      </ConfirmationDialogProvider>
    ),
    interact: async (frame) => {
      await new Promise(requestAnimationFrame)
      const target =
        from === 'agent-row'
          ? frame.querySelectorAll(`[${WORKSPACE_AGENT_ROW_ATTR}]`)[1]
          : from === 'expander'
            ? Array.from(frame.querySelectorAll('span')).find(
                (node) => node.textContent === '2 agents'
              )
            : frame.querySelector('[data-worktree-card-surface]')
      const box = target?.getBoundingClientRect()
      target?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: (box?.left ?? 0) + 120,
          clientY: (box?.top ?? 0) + 10
        })
      )
      await new Promise(requestAnimationFrame)
    }
  })
}

export const compactAgentRow = menuFrom('agent-row', 'compact')
export const fullAgentRow = menuFrom('agent-row', 'full')
export const cardHeader = menuFrom('header', 'compact')
export const agentsExpander = menuFrom('expander', 'compact')
// The outline must show over the active and multi-selected looks too.
export const activeCardAgentRow = menuFrom('agent-row', 'compact', { isActive: true })
export const selectedCardAgentRow = menuFrom('agent-row', 'compact', { isMultiSelected: true })
