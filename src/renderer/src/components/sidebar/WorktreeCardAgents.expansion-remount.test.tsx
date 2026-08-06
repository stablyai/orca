// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearWorktreeAgentExpansionStateForTests,
  getWorktreeAgentExpansionCountForTests,
  MAX_PERSISTED_WORKTREE_AGENT_EXPANSIONS,
  seedWorktreeAgentExpansionStateForTests,
  useWorktreeAgentExpansionState
} from './worktree-card-agents-expansion-state'

let mockAgents: unknown[] = []

function mockAgent(paneKey: string, prompt: string): unknown {
  return {
    paneKey,
    tab: { id: paneKey.split(':')[0] },
    agentType: 'codex',
    rowSource: undefined,
    state: 'done',
    startedAt: 1000,
    entry: {
      prompt,
      lastAssistantMessage: undefined,
      state: 'done',
      stateStartedAt: 1000,
      stateHistory: [],
      orchestration: undefined
    },
    lineage: undefined
  }
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      agentActivityDisplayMode: 'compact',
      acknowledgedAgentsByPaneKey: {},
      cacheTimerByKey: {},
      dropAgentStatus: vi.fn(),
      dismissRetainedAgent: vi.fn(),
      agentSendPopoverTargetMode: null,
      agentStatusByPaneKey: {},
      agentStatusEpoch: 0,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      runtimePaneTitlesByTabId: {},
      sendPromptToSidebarAgentTarget: vi.fn(),
      settings: { promptCacheTimerEnabled: false, promptCacheTtlMs: 60_000 }
    })
}))

vi.mock('./useWorktreeAgentRows', () => ({
  useWorktreeAgentRows: vi.fn(() => mockAgents)
}))

vi.mock('@/components/dashboard/useNow', () => ({
  useNow: vi.fn(() => 2000)
}))

vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownForPane: () => null,
  usePromptCacheCountdownStartedAt: () => null
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: vi.fn()
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

const mountedRoots: { root: Root; host: HTMLElement }[] = []

async function mountAgents(worktreeId: string): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  mountedRoots.push({ root, host })
  const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')
  await act(async () => {
    root.render(<WorktreeCardAgents worktreeId={worktreeId} />)
  })
  return host
}

function summaryButton(host: HTMLElement): HTMLButtonElement {
  // The compact multi-agent summary is the only control carrying aria-expanded
  // when the agents are flat (no per-agent child disclosure).
  const button = host.querySelector<HTMLButtonElement>('button[aria-expanded]')
  if (!button) {
    throw new Error('compact agent summary button not found')
  }
  return button
}

describe('WorktreeCardAgents inline-list expansion durability', () => {
  beforeEach(() => {
    clearWorktreeAgentExpansionStateForTests()
    mockAgents = [mockAgent('tab-1:1', 'One'), mockAgent('tab-2:2', 'Two')]
  })

  afterEach(async () => {
    await act(async () => {
      for (const { root, host } of mountedRoots.splice(0)) {
        root.unmount()
        host.remove()
      }
    })
    document.body.innerHTML = ''
    clearWorktreeAgentExpansionStateForTests()
  })

  it('keeps the compact agent summary expanded across a card remount', async () => {
    const host = await mountAgents('wt-remount')
    expect(summaryButton(host).getAttribute('aria-expanded')).toBe('false')

    await act(async () => {
      summaryButton(host).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(summaryButton(host).getAttribute('aria-expanded')).toBe('true')

    // Simulate the WorktreeCard remount that a virtualizer recycle or a sibling
    // child-worktrees toggle triggers: fully unmount, then mount a fresh tree
    // for the same worktree. Before the fix this reset the summary to collapsed.
    await act(async () => {
      const first = mountedRoots.shift()!
      first.root.unmount()
      first.host.remove()
    })
    const remounted = await mountAgents('wt-remount')

    expect(summaryButton(remounted).getAttribute('aria-expanded')).toBe('true')
  })

  it('does not leak expansion between different worktrees', async () => {
    const first = await mountAgents('wt-a')
    await act(async () => {
      summaryButton(first).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(summaryButton(first).getAttribute('aria-expanded')).toBe('true')

    const second = await mountAgents('wt-b')
    expect(summaryButton(second).getAttribute('aria-expanded')).toBe('false')
  })
})

describe('worktree-card-agents-expansion-state module cache', () => {
  beforeEach(() => {
    clearWorktreeAgentExpansionStateForTests()
  })

  afterEach(() => {
    clearWorktreeAgentExpansionStateForTests()
  })

  it('persists a collapsed lineage parent across a hook remount and toggles independently', async () => {
    function Probe({ worktreeId }: { worktreeId: string }) {
      const { collapsedLineageParents, toggleLineageParent } =
        useWorktreeAgentExpansionState(worktreeId)
      return (
        <button
          type="button"
          data-collapsed={collapsedLineageParents.has('pane-x') ? 'true' : 'false'}
          onClick={() => toggleLineageParent('pane-x')}
        >
          probe
        </button>
      )
    }

    const host = document.createElement('div')
    document.body.append(host)
    let root = createRoot(host)
    await act(async () => {
      root.render(<Probe worktreeId="wt-probe" />)
    })
    const read = () => host.querySelector('button')!.getAttribute('data-collapsed')
    expect(read()).toBe('false')

    await act(async () => {
      host.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(read()).toBe('true')

    // Remount the hook consumer: the collapsed parent must survive.
    await act(async () => root.unmount())
    root = createRoot(host)
    await act(async () => {
      root.render(<Probe worktreeId="wt-probe" />)
    })
    expect(read()).toBe('true')

    await act(async () => root.unmount())
    host.remove()
  })

  it('drops default (empty) state and bounds the cache with LRU eviction', () => {
    seedWorktreeAgentExpansionStateForTests('wt-default', {
      collapsedLineageParents: new Set(),
      compactRootListExpanded: false
    })
    expect(getWorktreeAgentExpansionCountForTests()).toBe(0)

    for (let i = 0; i < MAX_PERSISTED_WORKTREE_AGENT_EXPANSIONS + 25; i++) {
      seedWorktreeAgentExpansionStateForTests(`wt-${i}`, {
        collapsedLineageParents: new Set(),
        compactRootListExpanded: true
      })
    }
    expect(getWorktreeAgentExpansionCountForTests()).toBe(MAX_PERSISTED_WORKTREE_AGENT_EXPANSIONS)
  })
})
