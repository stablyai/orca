import { DndContext } from '@dnd-kit/core'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { makeUnifiedTab, makeTabGroup } from '@/store/slices/tabs/tab-group.test-fixture'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
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

const worktree = makeWorktree({ id: WORKSPACE_ID, repoId: repo.id, path: '/workspace/orca' })
const tabs = ['Claude recovery', 'Claude follow-up'].map((title, index) =>
  makeTab({ id: `term-${index}`, worktreeId: WORKSPACE_ID, title, launchAgent: 'claude' })
)
const activeClaudeTab = tabs[0]!

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
          groupActiveTabId="utab-0"
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

function searchFixture(count: number, query = 'cl', qwenWorkInstalled = false) {
  const fixtureTabs = tabs.slice(0, count)
  const unifiedTabs = fixtureTabs.map((tab, index) =>
    makeUnifiedTab({
      id: `utab-${index}`,
      entityId: tab.id,
      groupId: GROUP_ID,
      worktreeId: WORKSPACE_ID,
      label: tab.title,
      sortOrder: index
    })
  )
  return defineFixture({
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
      tabsByWorktree: { [WORKSPACE_ID]: fixtureTabs },
      groupsByWorktree: {
        [WORKSPACE_ID]: [
          makeTabGroup({
            id: GROUP_ID,
            worktreeId: WORKSPACE_ID,
            activeTabId: 'utab-0',
            tabOrder: unifiedTabs.map((tab) => tab.id)
          })
        ]
      },
      unifiedTabsByWorktree: { [WORKSPACE_ID]: unifiedTabs }
    },
    render: () => <Strip tabs={fixtureTabs} />,
    interact: async (frame) => {
      const shell = window.api.shell
      const original = shell.isQwenWorkAvailable
      try {
        shell.isQwenWorkAvailable = async () => qwenWorkInstalled
        await openMenuAndSearch(frame, query)
      } finally {
        shell.isQwenWorkAvailable = original
      }
    }
  })
}

export const activeTabOmitted = searchFixture(1)
export const inactiveTabOffered = searchFixture(2)
export const qwenWorkInstalled = searchFixture(1, '', true)
export const qwenWorkSearch = searchFixture(1, '千问', true)
