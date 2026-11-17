import { useAppStore } from '@/store'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import WorktreeCardAgents from './WorktreeCardAgents'
import { clearWorktreeAgentExpansionStateForTests } from './worktree-card-agents-expansion-state'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentChildWorkView } from '../../../../../../shared/agent-status/child-work/agent-status-child-work-view'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'

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

function setupRows(worktreeId: string) {
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
  useAppStore.setState({
    tabsByWorktree: { [worktreeId]: [tab] },
    agentStatusByPaneKey: acceptedAgentStatuses([[parent.paneKey, parent]])
  })
}

function render(worktreeId: string) {
  return (
    <div className="flex flex-col gap-0.5 bg-sidebar p-2 text-sidebar-foreground">
      <WorktreeCardAgents worktreeId={worktreeId} />
    </div>
  )
}

// Expansion state is module-global; reset so each theme pass starts collapsed.
const setup = (worktreeId: string) => () => {
  clearWorktreeAgentExpansionStateForTests()
  setupRows(worktreeId)
}

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
  setup: setup('fixture-subagents-rest'),
  render: () => render('fixture-subagents-rest')
})

export const userExpanded = defineFixture({
  width: 300,
  store: { agentActivityDisplayMode: 'compact' },
  setup: setup('fixture-subagents-expanded'),
  render: () => render('fixture-subagents-expanded'),
  interact: async (frame) => {
    expand(frame, '[data-agent-child-disclosure-button]')
    await wait()
  }
})

export const idleGroupExpanded = defineFixture({
  width: 300,
  store: { agentActivityDisplayMode: 'compact' },
  setup: setup('fixture-subagents-idle-open'),
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
  setup: setup('fixture-subagents-full'),
  render: () => render('fixture-subagents-full'),
  interact: async (frame) => {
    expand(frame, '[data-agent-child-disclosure-button]')
    await wait()
  }
})

export const fullModeCollapsed = defineFixture({
  width: 300,
  store: { agentActivityDisplayMode: 'full' },
  setup: setup('fixture-subagents-full-rest'),
  render: () => render('fixture-subagents-full-rest')
})

function setupAntigravitySwarm(worktreeId: string, withSubagents: boolean) {
  return () => {
    clearWorktreeAgentExpansionStateForTests()
    const tab: TerminalTab = {
      id: `${worktreeId}-tab`,
      ptyId: null,
      worktreeId,
      title: 'Antigravity',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: now
    }
    const parent: AgentStatusEntry = {
      paneKey: `${tab.id}:${LEAF}`,
      worktreeId,
      tabId: tab.id,
      agentType: 'antigravity',
      ...(withSubagents
        ? {
            model: 'gemini-3.1-pro-high',
            state: 'working',
            prompt: 'Audit auth & billing modules',
            toolName: 'swarm_wait',
            updatedAt: now,
            stateStartedAt: now - 180_000,
            stateHistory: [],
            subagents: [
              {
                id: 'worker-auth',
                agentType: 'Swarm Worker',
                model: 'gemini-3.1-pro-high',
                description: 'auth_audit',
                toolName: 'read_file',
                toolInput: 'src/auth/session.ts',
                state: 'working',
                startedAt: now - 120_000
              },
              {
                id: 'worker-billing',
                agentType: 'Swarm Worker',
                model: 'gemini-3-flash',
                description: 'billing_check',
                toolName: 'run_command',
                toolInput: 'pnpm test src/billing',
                state: 'working',
                startedAt: now - 90_000
              },
              {
                id: 'subagent-research',
                agentType: 'research',
                model: 'gemini-3-flash',
                description: 'Codebase Researcher',
                toolName: 'grep_search',
                toolInput: 'sessionToken',
                state: 'working',
                startedAt: now - 45_000
              }
            ]
          }
        : {
            state: 'working',
            prompt: '',
            updatedAt: now,
            stateStartedAt: now - 180_000,
            stateHistory: []
          })
    }
    useAppStore.setState({
      tabsByWorktree: { [worktreeId]: [tab] },
      agentStatusByPaneKey: acceptedAgentStatuses([[parent.paneKey, parent]])
    })
  }
}

export const antigravityBefore = defineFixture({
  width: 300,
  store: { agentActivityDisplayMode: 'full', showAgentModels: true },
  setup: setupAntigravitySwarm('fixture-agy-before', false),
  render: () => render('fixture-agy-before')
})

export const antigravitySwarmCollapsed = defineFixture({
  width: 300,
  store: { agentActivityDisplayMode: 'full', showAgentModels: true },
  setup: setupAntigravitySwarm('fixture-agy-collapsed', true),
  render: () => render('fixture-agy-collapsed')
})

export const antigravitySwarmExpanded = defineFixture({
  width: 300,
  store: { agentActivityDisplayMode: 'full', showAgentModels: true },
  setup: setupAntigravitySwarm('fixture-agy-expanded', true),
  render: () => render('fixture-agy-expanded'),
  interact: async (frame) => {
    expand(frame, '[data-agent-child-disclosure-button]')
    await wait()
  }
})
