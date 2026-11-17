import { DndContext } from '@dnd-kit/core'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import TabBar from '../TabBar'

const WORKSPACE_ID = 'create-entry-fixture'
const GROUP_ID = 'create-entry-group'

const repo: Repo = {
  id: 'repo-1',
  path: '/workspace/orca',
  displayName: 'orca',
  badgeColor: '#3b82f6',
  addedAt: 0
}

const worktree: Worktree = {
  id: WORKSPACE_ID,
  repoId: repo.id,
  path: '/workspace/orca',
  head: 'abc1234',
  branch: 'refs/heads/main',
  isBare: false,
  isMainWorktree: true,
  displayName: 'orca',
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

const activeClaudeTab: TerminalTab = {
  id: 'term-active',
  worktreeId: WORKSPACE_ID,
  ptyId: null,
  title: 'Claude recovery',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 0,
  launchAgent: 'claude'
}

const inactiveClaudeTab: TerminalTab = {
  id: 'term-inactive',
  worktreeId: WORKSPACE_ID,
  ptyId: null,
  title: 'Claude follow-up',
  customTitle: null,
  color: null,
  sortOrder: 1,
  createdAt: 1,
  launchAgent: 'claude'
}

const noop = (): void => {}
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 250))

async function openMenuAndSearch(frame: HTMLElement, query: string): Promise<void> {
  const trigger = frame.querySelector<HTMLButtonElement>(
    '[data-contextual-tour-target="tab-create-menu"]'
  )
  trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  trigger?.click()
  await settle()
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')
  if (input) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, query)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  await settle()
}

function Strip({ tabs }: { tabs: TerminalTab[] }): React.JSX.Element {
  return (
    <DndContext>
      <div className="@container/tab-strip h-8 bg-card">
        <TabBar
          tabs={tabs}
          activeTabId={activeClaudeTab.id}
          activeTabType="terminal"
          worktreeId={WORKSPACE_ID}
          groupId={GROUP_ID}
          groupActiveTabId="utab-active"
          expandedPaneByTabId={{}}
          showAgentLaunchItems
          onActivate={noop}
          onClose={noop}
          onCloseOthers={noop}
          onCloseToRight={noop}
          onCloseToLeft={noop}
          onNewTerminalTab={noop}
          onNewBrowserTab={noop}
          onOpenEntry={async () => {}}
          onSetCustomTitle={noop}
          onSetTabColor={noop}
          onTogglePaneExpand={noop}
        />
      </div>
    </DndContext>
  )
}

export const activeTabOmitted = defineFixture({
  width: 560,
  store: {
    activeWorktreeId: WORKSPACE_ID,
    activeTabId: activeClaudeTab.id,
    activeTabType: 'terminal',
    activeGroupIdByWorktree: { [WORKSPACE_ID]: GROUP_ID },
    repos: [repo],
    worktreesByRepo: { [repo.id]: [worktree] },
    localDetectedAgentIdsByContext: { host: ['claude', 'codex'] },
    ensureDetectedAgents: async () => ['claude', 'codex'],
    tabsByWorktree: { [WORKSPACE_ID]: [activeClaudeTab] },
    groupsByWorktree: {
      [WORKSPACE_ID]: [
        {
          id: GROUP_ID,
          worktreeId: WORKSPACE_ID,
          activeTabId: 'utab-active',
          tabOrder: ['utab-active']
        }
      ]
    },
    unifiedTabsByWorktree: {
      [WORKSPACE_ID]: [
        {
          id: 'utab-active',
          entityId: activeClaudeTab.id,
          groupId: GROUP_ID,
          worktreeId: WORKSPACE_ID,
          contentType: 'terminal',
          label: activeClaudeTab.title,
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    }
  },
  render: () => <Strip tabs={[activeClaudeTab]} />,
  interact: (frame) => openMenuAndSearch(frame, 'cl')
})

export const inactiveTabOffered = defineFixture({
  width: 560,
  store: {
    activeWorktreeId: WORKSPACE_ID,
    activeTabId: activeClaudeTab.id,
    activeTabType: 'terminal',
    activeGroupIdByWorktree: { [WORKSPACE_ID]: GROUP_ID },
    repos: [repo],
    worktreesByRepo: { [repo.id]: [worktree] },
    localDetectedAgentIdsByContext: { host: ['claude', 'codex'] },
    ensureDetectedAgents: async () => ['claude', 'codex'],
    tabsByWorktree: { [WORKSPACE_ID]: [activeClaudeTab, inactiveClaudeTab] },
    groupsByWorktree: {
      [WORKSPACE_ID]: [
        {
          id: GROUP_ID,
          worktreeId: WORKSPACE_ID,
          activeTabId: 'utab-active',
          tabOrder: ['utab-active', 'utab-inactive']
        }
      ]
    },
    unifiedTabsByWorktree: {
      [WORKSPACE_ID]: [
        {
          id: 'utab-active',
          entityId: activeClaudeTab.id,
          groupId: GROUP_ID,
          worktreeId: WORKSPACE_ID,
          contentType: 'terminal',
          label: activeClaudeTab.title,
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        },
        {
          id: 'utab-inactive',
          entityId: inactiveClaudeTab.id,
          groupId: GROUP_ID,
          worktreeId: WORKSPACE_ID,
          contentType: 'terminal',
          label: inactiveClaudeTab.title,
          customLabel: null,
          color: null,
          sortOrder: 1,
          createdAt: 1
        }
      ]
    }
  },
  render: () => <Strip tabs={[activeClaudeTab, inactiveClaudeTab]} />,
  interact: (frame) => openMenuAndSearch(frame, 'cl')
})
