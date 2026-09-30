// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { TooltipProvider } from '@/components/ui/tooltip'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  clearWorktreeAgentExpansionStateForTests,
  seedWorktreeAgentExpansionStateForTests
} from './worktree-card-agents-expansion-state'
import WorktreeCardAgents from './WorktreeCardAgents'

const WORKSPACE = 'acknowledgement-workspace'
const PANE_A = makePaneKey('tab-a', '11111111-1111-4111-8111-111111111111')
const PANE_B = makePaneKey('tab-b', '22222222-2222-4222-8222-222222222222')
let acknowledgements: Record<string, number> = {}
let focusedPaneKey: string | null = null

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      agentActivityDisplayMode: 'compact',
      acknowledgedAgentsByPaneKey: acknowledgements,
      agentSendPopoverTargetMode: null,
      dropAgentStatus: vi.fn(),
      dismissRetainedAgent: vi.fn(),
      sendPromptToSidebarAgentTarget: vi.fn()
    })
}))
vi.mock('./useWorktreeAgentRows', () => ({ useWorktreeAgentRows: () => [] }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({ activateTabAndFocusPane: vi.fn() }))
vi.mock('@/hooks/use-now', () => ({ useNow: () => 5000 }))
vi.mock('./focused-agent-row-highlight', () => ({
  useFocusedAgentPaneKey: () => focusedPaneKey
}))
vi.mock('@/components/dashboard/use-agent-row-conversation-name', () => ({
  useAgentRowConversationName: () => null
}))
vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownForPane: () => null
}))

function agentRow(
  paneKey: string,
  state: DashboardAgentRow['state'] = 'done',
  entry: Partial<DashboardAgentRow['entry']> = {}
): DashboardAgentRow {
  const tabId = paneKey === PANE_A ? 'tab-a' : 'tab-b'
  return {
    paneKey,
    agentType: 'codex',
    rowSource: 'live',
    state,
    startedAt: 1000,
    tab: {
      id: tabId,
      ptyId: null,
      worktreeId: WORKSPACE,
      title: tabId,
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1000
    },
    entry: {
      paneKey,
      worktreeId: WORKSPACE,
      state:
        state === 'idle' || state === 'unverifiable' || state === 'unreported' ? 'done' : state,
      prompt: paneKey === PANE_A ? 'Review agent A' : 'Review agent B',
      lastAssistantMessage: 'Result details',
      stateStartedAt: 2000,
      updatedAt: 2000,
      stateHistory: [],
      ...entry
    }
  }
}

function renderLabels(agents: DashboardAgentRow[]): HTMLElement[] {
  const container = document.createElement('div')
  container.innerHTML = renderToStaticMarkup(
    <TooltipProvider>
      <WorktreeCardAgents worktreeId={WORKSPACE} agents={agents} />
    </TooltipProvider>
  )
  return [
    ...container.querySelectorAll<HTMLElement>('.compact-agent-row .flex-1 > span:first-child')
  ]
}

function expectEmphasis(label: HTMLElement | undefined, unvisited: boolean): void {
  expect(label).toBeDefined()
  expect(label?.classList.contains('font-semibold')).toBe(unvisited)
  expect(label?.classList.contains('font-normal')).toBe(!unvisited)
  expect(label?.classList.contains('text-foreground')).toBe(unvisited)
}

beforeEach(() => {
  acknowledgements = { [PANE_B]: 2000 }
  focusedPaneKey = null
  clearWorktreeAgentExpansionStateForTests()
  seedWorktreeAgentExpansionStateForTests(WORKSPACE, {
    compactRootListExpanded: true,
    collapsedLineageParents: new Set()
  })
})

describe('compact acknowledgement emphasis through WorktreeCardAgents', () => {
  it('changes only A when its acknowledgement covers its current turn', () => {
    const agents = [agentRow(PANE_A), agentRow(PANE_B)]
    const [aBefore, bBefore] = renderLabels(agents)
    expectEmphasis(aBefore, true)
    expectEmphasis(bBefore, false)
    acknowledgements = { ...acknowledgements, [PANE_A]: 2000 }
    const [aAfter, bAfter] = renderLabels(agents)
    expectEmphasis(aAfter, false)
    expect(bAfter?.outerHTML).toBe(bBefore?.outerHTML)
  })

  it.each([
    { ack: undefined, timestamp: 2000, emphasized: true },
    { ack: 1999, timestamp: 2000, emphasized: true },
    { ack: 2000, timestamp: 2000, emphasized: false },
    { ack: 2001, timestamp: 2000, emphasized: false },
    { ack: undefined, timestamp: 0, emphasized: false }
  ])('uses ack $ack against timestamp $timestamp', ({ ack, timestamp, emphasized }) => {
    acknowledgements = ack === undefined ? {} : { [PANE_A]: ack }
    const [label] = renderLabels([agentRow(PANE_A, 'done', { stateStartedAt: timestamp })])
    expectEmphasis(label, emphasized)
  })

  it.each(['working', 'blocked', 'waiting', 'done', 'idle', 'unverifiable'] as const)(
    'uses the same age rule for %s rows',
    (state) => {
      const row = agentRow(PANE_A, state)
      expectEmphasis(renderLabels([row])[0], true)
      acknowledgements = { [PANE_A]: 2000 }
      expectEmphasis(renderLabels([row])[0], false)
    }
  )

  it.each([false, true])('preserves focused contrast when unvisited is %s', (unvisited) => {
    focusedPaneKey = PANE_A
    acknowledgements = unvisited ? {} : { [PANE_A]: 2000 }
    const [label] = renderLabels([agentRow(PANE_A)])
    expect(label?.classList.contains('text-foreground')).toBe(true)
    expect(label?.classList.contains('font-semibold')).toBe(unvisited)
    expect(label?.classList.contains('font-normal')).toBe(!unvisited)
    expect(label?.nextElementSibling?.className).toBe('text-foreground/70')
  })

  it('emphasizes the monitoring label while preserving prompt ordering', () => {
    const [label] = renderLabels([agentRow(PANE_A, 'working', { workingMode: 'monitoring' })])
    expectEmphasis(label, true)
    expect(label?.textContent).toBe('Monitoring background tasks')
    expect(label?.nextElementSibling?.textContent).toContain('Review agent A')
  })

  it('keeps interruption text secondary to the acknowledgement signal', () => {
    const [label] = renderLabels([agentRow(PANE_A, 'done', { interrupted: true })])
    expectEmphasis(label, true)
    expect(label?.nextElementSibling?.textContent).toContain('Interrupted by user')
  })

  it('does not treat same-state output as a new turn, but admits a newer timestamp', () => {
    acknowledgements = { [PANE_A]: 2000 }
    expectEmphasis(renderLabels([agentRow(PANE_A)])[0], false)
    expectEmphasis(
      renderLabels([
        agentRow(PANE_A, 'done', { updatedAt: 3000, lastAssistantMessage: 'More output' })
      ])[0],
      false
    )
    expectEmphasis(renderLabels([agentRow(PANE_A, 'done', { stateStartedAt: 3000 })])[0], true)
  })
})
