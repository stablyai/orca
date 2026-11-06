import { defineFixture } from '../../component-fixtures/component-fixture'
import { clearWorktreeAgentExpansionStateForTests } from './workspace-card/activity/worktree-card-agents-expansion-state'
import { buildWorktreeAgentRows } from './workspace-card/activity/worktree-agent-rows'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentChildWorkView } from '../../../../shared/agent-status/child-work/agent-status-child-work-view'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import { buildSlotAgentSignals } from './worktree-card-slot-agent-signals'
import { WorktreeCardSlotAgentLines } from './WorktreeCardSlotAgentLines'

const now = Date.now()
const MINUTE = 60_000
const LEAF = '22222222-2222-4222-8222-222222222222'

function child(
  id: string,
  name: string,
  state: AgentChildWorkView['state'],
  startedAgo: number
): AgentChildWorkView {
  return {
    id,
    providerId: `task-${id}`,
    kind: 'agent',
    name,
    agentType: 'general-purpose',
    state,
    membership: 'live',
    ...(state === 'working'
      ? {
          operation: {
            toolName: 'Read',
            input: 'src/plugins/manifest.ts',
            basis: 'open' as const,
            observedAt: now
          }
        }
      : {}),
    firstObservedAt: now - startedAgo,
    observedAt: now,
    stoppable: true,
    invocation: { invocationId: `spawn-${id}`, generation: 1 }
  }
}

function rowsFor(worktreeId: string) {
  const tab: TerminalTab = {
    id: `${worktreeId}-tab`,
    ptyId: null,
    worktreeId,
    title: 'Claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: now
  }
  const lead: AgentStatusEntry = {
    paneKey: `${tab.id}:${LEAF}`,
    worktreeId,
    tabId: tab.id,
    agentType: 'claude',
    state: 'working',
    prompt: 'Orca plugin architecture review',
    updatedAt: now,
    stateStartedAt: now - 12 * MINUTE,
    stateHistory: [],
    children: [
      child('a', 'plugin-dx', 'idle', 40 * MINUTE),
      child('b', 'declarative-ui', 'idle', 30 * MINUTE),
      child('c', 'sandbox-model', 'idle', 30 * MINUTE),
      child('d', 'manifest-schema', 'working', 3 * MINUTE)
    ]
  }
  return buildWorktreeAgentRows({ tabs: [tab], entries: [lead], retained: [], now })
}

function render(worktreeId: string) {
  const agents = rowsFor(worktreeId)
  return (
    <div className="worktree-sidebar bg-worktree-sidebar p-2 pl-4 text-worktree-sidebar-foreground">
      <WorktreeCardSlotAgentLines
        worktreeId={worktreeId}
        agents={agents}
        signals={buildSlotAgentSignals(agents, [])}
        now={now}
        offline={false}
        cacheTimersActive
      />
    </div>
  )
}

const wait = () => new Promise((resolve) => setTimeout(resolve, 300))

export const subagentsFolded = defineFixture({
  width: 300,
  setup: clearWorktreeAgentExpansionStateForTests,
  render: () => render('fixture-slot-subagents')
})

export const subagentsExpanded = defineFixture({
  width: 300,
  setup: clearWorktreeAgentExpansionStateForTests,
  render: () => render('fixture-slot-subagents-open'),
  interact: async (frame) => {
    frame.querySelector<HTMLElement>('[role="treeitem"] button[aria-expanded="false"]')?.click()
    await wait()
    frame.querySelector<HTMLElement>('[data-idle-child-agent-group]')?.click()
    await wait()
  }
})

export const pickingSendTarget = defineFixture({
  width: 300,
  setup: clearWorktreeAgentExpansionStateForTests,
  store: {
    agentSendPopoverTargetMode: {
      id: 'fixture-send',
      instanceId: 'fixture-send-1',
      worktreeId: 'fixture-slot-picking',
      source: 'diff-notes',
      prompt: 'Review these notes',
      label: 'Diff notes',
      launchSource: 'sidebar',
      eligiblePaneKeys: [],
      disabledPaneKeys: {},
      status: 'open'
    } as unknown as AppState['agentSendPopoverTargetMode']
  },
  render: () => render('fixture-slot-picking')
})
