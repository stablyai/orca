import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { CompactAgentRow } from './worktree-card-compact-agent-row'
import type { Tab } from '../../../../../../shared/tab-types'

const agent: DashboardAgentRow = {
  paneKey: 'fixture-agent:11111111-1111-4111-8111-111111111111',
  tab: {
    id: 'fixture-agent',
    worktreeId: 'fixture-workspace',
    ptyId: null,
    title: 'Review API changes',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  },
  agentType: 'codex',
  state: 'done',
  startedAt: 1,
  rowSource: 'live',
  entry: {
    paneKey: 'fixture-agent:11111111-1111-4111-8111-111111111111',
    tabId: 'fixture-agent',
    worktreeId: 'fixture-workspace',
    agentType: 'codex',
    state: 'done',
    prompt: 'Review API changes',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    providerSession: { key: 'session_id', id: 'example-session-id' }
  }
}
const tab: Tab = {
  id: 'fixture-unified',
  entityId: agent.tab.id,
  worktreeId: agent.tab.worktreeId,
  groupId: 'fixture-group',
  contentType: 'terminal',
  label: agent.tab.title,
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1,
  viewMode: 'chat'
}
const store = {
  tabsByWorktree: { [agent.tab.worktreeId]: [agent.tab] },
  unifiedTabsByWorktree: { [agent.tab.worktreeId]: [tab] }
}
const render = () => (
  <div className="min-h-80 bg-sidebar p-4 text-sidebar-foreground">
    <CompactAgentRow agent={agent} now={60_000} onActivate={() => {}} />
  </div>
)
export const closed = defineFixture({ width: 420, store, render })
export const open = defineFixture({
  width: 420,
  store,
  render,
  interact: async (frame) => {
    const button = frame.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
    button?.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
    )
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
})

function splitFixture(chatLeafId: string) {
  return defineFixture({
    width: 420,
    store: {
      ...store,
      terminalLayoutsByTabId: {
        [agent.tab.id]: {
          root: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: '11111111-1111-4111-8111-111111111111' },
            second: { type: 'leaf', leafId: '22222222-2222-4222-8222-222222222222' }
          },
          activeLeafId: chatLeafId,
          expandedLeafId: null,
          chatLeafId
        }
      }
    },
    render
  })
}
export const splitOwner = splitFixture('11111111-1111-4111-8111-111111111111')
export const splitSibling = splitFixture('22222222-2222-4222-8222-222222222222')
