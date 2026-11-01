import { defineFixture } from '../../component-fixtures/component-fixture'
import WorktreeCardAgents from './WorktreeCardAgents'
import { clearWorktreeAgentExpansionStateForTests } from './worktree-card-agents-expansion-state'
import { buildWorktreeAgentRows } from './worktree-agent-rows'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AgentChildWorkView } from '../../../../shared/agent-status-child-work-view'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

const now = Date.now()
const HOUR = 3_600_000
const LEAF = '11111111-1111-4111-8111-111111111111'

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
  const parent: AgentStatusEntry = {
    paneKey: `${tab.id}:${LEAF}`,
    worktreeId,
    tabId: tab.id,
    agentType: 'claude',
    state: 'working',
    prompt: 'Orca plugin architecture review',
    updatedAt: now,
    stateStartedAt: now - 5 * HOUR,
    stateHistory: [],
    children: [
      child('a', 'plugin-dx', 'idle', 4 * HOUR),
      child('b', 'declarative-ui', 'idle', 3 * HOUR),
      child('c', 'sandbox-model', 'idle', 3 * HOUR),
      child('d', 'manifest-schema', 'working', 0.2 * HOUR)
    ]
  }
  return buildWorktreeAgentRows({ tabs: [tab], entries: [parent], retained: [], now })
}

function render(worktreeId: string) {
  return (
    <div className="flex flex-col gap-0.5 bg-sidebar p-2 text-sidebar-foreground">
      <WorktreeCardAgents worktreeId={worktreeId} agents={rowsFor(worktreeId)} />
    </div>
  )
}

// Expansion state is module-global; reset so each theme pass starts collapsed.
const setup = clearWorktreeAgentExpansionStateForTests

function expand(frame: HTMLElement, selector: string): void {
  const toggle = frame.querySelector<HTMLElement>(selector)
  if (toggle?.closest('[aria-expanded]')?.getAttribute('aria-expanded') === 'false') {
    toggle.click()
  }
}

const wait = () => new Promise((resolve) => setTimeout(resolve, 300))

export const atRest = defineFixture({
  width: 300,
  store: { agentActivityDisplayMode: 'compact' },
  setup,
  render: () => render('fixture-subagents-rest')
})

export const userExpanded = defineFixture({
  width: 300,
  store: { agentActivityDisplayMode: 'compact' },
  setup,
  render: () => render('fixture-subagents-expanded'),
  interact: async (frame) => {
    expand(frame, '[data-agent-child-disclosure-button]')
    await wait()
  }
})

export const idleGroupExpanded = defineFixture({
  width: 300,
  store: { agentActivityDisplayMode: 'compact' },
  setup,
  render: () => render('fixture-subagents-idle-open'),
  interact: async (frame) => {
    expand(frame, '[data-agent-child-disclosure-button]')
    await wait()
    expand(frame, '[data-idle-child-agent-group]')
    await wait()
  }
})

export const fullMode = defineFixture({
  width: 300,
  store: { agentActivityDisplayMode: 'full' },
  setup,
  render: () => render('fixture-subagents-full'),
  interact: async (frame) => {
    expand(frame, '[data-agent-child-disclosure-button]')
    await wait()
  }
})

export const fullModeCollapsed = defineFixture({
  width: 300,
  store: { agentActivityDisplayMode: 'full' },
  setup,
  render: () => render('fixture-subagents-full-rest')
})
