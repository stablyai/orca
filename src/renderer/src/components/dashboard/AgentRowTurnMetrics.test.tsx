/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTurnUsage } from '../../../../shared/agent-turn-usage'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type { DashboardAgentRow } from './useDashboardData'
import { AgentRowTurnMetrics } from './AgentRowTurnMetrics'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const DIFF_TITLE = '🌐 jcode/castle Skunk · +2 -1 · last ~10s'
const usageA: AgentTurnUsage = {
  inputTokens: 616,
  outputTokens: 138,
  cacheReadTokens: 85906,
  cacheWriteTokens: 589,
  durationMs: 12632
}
const tab: TerminalTab = {
  id: 'tab-1',
  worktreeId: 'wt-1',
  ptyId: null,
  title: DIFF_TITLE,
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}
const fakeState: {
  tabsByWorktree: Record<string, TerminalTab[]>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  settings: object
} = {
  tabsByWorktree: { 'wt-1': [tab] },
  terminalLayoutsByTabId: {},
  runtimePaneTitlesByTabId: {},
  settings: {}
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof fakeState) => unknown) => selector(fakeState)
}))

function makeAgent(usage?: AgentTurnUsage): DashboardAgentRow {
  return {
    paneKey: `tab-1:${LEAF_A}`,
    tab,
    agentType: 'jcode',
    state: 'done',
    startedAt: 500,
    entry: {
      paneKey: `tab-1:${LEAF_A}`,
      state: 'done',
      prompt: '',
      updatedAt: 1000,
      stateStartedAt: 1000,
      stateHistory: [],
      lastTurnUsage: usage
    }
  }
}

let root: Root | undefined
let container: HTMLDivElement

beforeEach(() => {
  fakeState.tabsByWorktree = { 'wt-1': [{ ...tab }] }
  fakeState.terminalLayoutsByTabId = {}
  fakeState.runtimePaneTitlesByTabId = {}
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root?.unmount())
  document.body.replaceChildren()
})

function render(agent: DashboardAgentRow, focused?: boolean): void {
  act(() => root!.render(<AgentRowTurnMetrics agent={agent} focused={focused} />))
}

describe('AgentRowTurnMetrics', () => {
  it('shows usage and diff on a Jcode root row', () => {
    render(makeAgent(usageA), true)
    expect(container.querySelector('[data-agent-turn-metrics]')).not.toBeNull()
    expect(container.textContent).toContain('↑87.1k ↓138')
    expect(container.textContent).toContain('+2 -1')
    expect(container.querySelector('[title^="Last turn"]')?.getAttribute('title')).toBe(
      [
        'Last turn',
        'Input: 616',
        `Cache read: ${(85906).toLocaleString()}`,
        'Cache write: 589',
        'Output: 138',
        'Duration: 12s'
      ].join('\n')
    )
    expect(container.querySelector('[title^="Last turn"]')?.className).toContain(
      'text-foreground/70'
    )
    expect(container.querySelector('[title^="Whole session"]')?.getAttribute('title')).toBe(
      'Whole session: +2 -1 lines changed, not just this turn'
    )
    render(makeAgent(usageA), false)
    expect(container.querySelector('[title^="Last turn"]')?.className).toContain(
      'text-muted-foreground/70'
    )
  })

  it('renders nothing without usage or diff', () => {
    fakeState.tabsByWorktree['wt-1'][0].title = '🦨 jcode/castle Skunk · work ~0s'
    render(makeAgent())
    expect(container.innerHTML).toBe('')
  })

  it('never shows a diff chip on a non-Jcode row', () => {
    fakeState.tabsByWorktree['wt-1'][0].title = '✳ Fix jcode hooks · +3 -1'
    render({ ...makeAgent(), agentType: 'claude' })
    expect(container.innerHTML).toBe('')
  })

  it('shows no chips on child rows', () => {
    render({ ...makeAgent(usageA), rowSource: 'subagent' })
    expect(container.innerHTML).toBe('')
    render({
      ...makeAgent(usageA),
      childRow: {
        id: 'child-1',
        kind: 'agent',
        displayState: 'working',
        name: '',
        detail: null,
        firstObservedAt: 500,
        recencyAt: 1000,
        canStop: false,
        settled: false,
        owned: []
      }
    })
    expect(container.innerHTML).toBe('')
  })

  it('shows no diff chip for a split pane without its own title', () => {
    fakeState.terminalLayoutsByTabId['tab-1'] = {
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: LEAF_A },
        second: { type: 'leaf', leafId: LEAF_B }
      },
      activeLeafId: LEAF_A,
      expandedLeafId: null
    }
    fakeState.runtimePaneTitlesByTabId['tab-1'] = { 2: DIFF_TITLE }
    const agent = makeAgent()
    agent.entry.terminalTitle = DIFF_TITLE
    render(agent)
    expect(container.innerHTML).toBe('')
    // Negative control: give this leaf its own title, distinct from its sibling.
    fakeState.runtimePaneTitlesByTabId['tab-1'][1] = '🌐 jcode/castle Skunk · +1 -0 · last ~4s'
    render(agent)
    expect(container.textContent).toBe('+1')
  })

  it('shows no diff chip for a retained row without a live tab', () => {
    fakeState.tabsByWorktree['wt-1'] = []
    const agent = makeAgent()
    agent.entry.terminalTitle = DIFF_TITLE
    render({ ...agent, rowSource: 'retained' })
    expect(container.innerHTML).toBe('')
  })

  it('hides zero diff counts but keeps them in the tooltip', () => {
    // Negative controls: zero-count variants of the captured title.
    fakeState.tabsByWorktree['wt-1'][0].title = '🌐 jcode/castle Skunk · +0 -0'
    render(makeAgent())
    expect(container.innerHTML).toBe('')
    fakeState.tabsByWorktree['wt-1'][0].title = '🌐 jcode/castle Skunk · +5 -0'
    render(makeAgent())
    expect(container.textContent).toBe('+5')
    expect(container.querySelector('[title^="Whole session"]')?.getAttribute('title')).toContain(
      '+5 -0'
    )
    render(makeAgent({ inputTokens: 0, outputTokens: 0 }))
    expect(container.textContent).toContain('↑0 ↓0')
  })

  it('includes cached input in the prompt total', () => {
    render(makeAgent({ inputTokens: 616, outputTokens: 138 }))
    expect(container.textContent).toContain('↑616 ↓138')
    expect(container.querySelector('[title^="Last turn"]')?.getAttribute('title')).toBe(
      'Last turn\nInput: 616\nOutput: 138'
    )
    render(makeAgent(usageA))
    expect(container.textContent).toContain('↑87.1k ↓138')
  })
})
