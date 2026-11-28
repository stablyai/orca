import { useAppStore } from '@/store'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import WorktreeCardAgents from './WorktreeCardAgents'
import {
  clearWorktreeAgentExpansionStateForTests,
  seedWorktreeAgentExpansionStateForTests
} from './worktree-card-agents-expansion-state'
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

type ParentRow = Pick<AgentStatusEntry, 'prompt'> &
  Partial<Pick<AgentStatusEntry, 'model' | 'lastAssistantMessage' | 'children'>>

const PLUGIN_REVIEW: ParentRow = {
  prompt: 'Orca plugin architecture review',
  children: [
    child('a', 'plugin-dx', 'idle', 4 * HOUR),
    child('b', 'declarative-ui', 'idle', 3 * HOUR),
    child('c', 'sandbox-model', 'idle', 3 * HOUR),
    child('d', 'manifest-schema', 'working', 0.2 * HOUR)
  ]
}

function setupRows(worktreeId: string, parents: readonly ParentRow[]) {
  const tabs: TerminalTab[] = []
  const entries: [string, AgentStatusEntry][] = []
  parents.forEach((parent, index) => {
    const tab: TerminalTab = {
      id: `${worktreeId}-tab-${index}`,
      ptyId: null,
      worktreeId,
      title: 'Claude',
      customTitle: null,
      color: null,
      sortOrder: index,
      createdAt: now
    }
    const paneKey = `${tab.id}:${LEAF}`
    tabs.push(tab)
    entries.push([
      paneKey,
      {
        paneKey,
        worktreeId,
        tabId: tab.id,
        agentType: 'claude',
        state: 'working',
        updatedAt: now,
        stateStartedAt: now - 5 * HOUR,
        stateHistory: [],
        ...parent
      }
    ])
  })
  useAppStore.setState({
    tabsByWorktree: { [worktreeId]: tabs },
    agentStatusByPaneKey: acceptedAgentStatuses(entries)
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
const setup =
  (worktreeId: string, parents: readonly ParentRow[] = [PLUGIN_REVIEW]) =>
  () => {
    clearWorktreeAgentExpansionStateForTests()
    setupRows(worktreeId, parents)
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

// Long, short and chipless titles, plus a subagent with its own model, at the narrowest (220)
// and default (280) sidebar widths.
const MODEL_ROWS: ParentRow[] = [
  { prompt: 'Plan the sidebar model chip layout', model: 'claude-opus-5-5' },
  {
    prompt: 'Fix flaky test',
    model: 'gpt-5.5-codex',
    lastAssistantMessage: 'Pinned the clock and the retry now passes.'
  },
  { prompt: 'Short', model: 'claude-opus-5-5' },
  { prompt: 'Draft the release notes' },
  {
    prompt: 'Summarize the review feedback',
    model: 'claude-opus-5-5',
    children: [
      { ...child('e', 'review-summarizer', 'working', 0.1 * HOUR), model: 'claude-haiku-4-5' }
    ]
  }
]

function modelRows(mode: 'compact' | 'full', width: number) {
  const worktreeId = `fixture-subagents-models-${mode}-${width}`
  return defineFixture({
    width,
    store: { agentActivityDisplayMode: mode },
    setup: () => {
      setup(worktreeId, MODEL_ROWS)()
      seedWorktreeAgentExpansionStateForTests(worktreeId, {
        expandedLineageParents: new Set(),
        expandedIdleChildGroups: new Set(),
        compactRootListExpanded: true
      })
    },
    render: () => render(worktreeId),
    interact: async (frame) => {
      expand(frame, '[data-agent-child-disclosure-button]')
      await wait()
    }
  })
}

export const modelsCompactNarrow = modelRows('compact', 220)
export const modelsCompactDefault = modelRows('compact', 280)
export const modelsFullNarrow = modelRows('full', 220)
export const modelsFullDefault = modelRows('full', 280)
