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
      retainedAgentsByPaneKey: {},
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

vi.mock('@/hooks/use-now', () => ({
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
    root.render(
      <div data-worktree-sidebar>
        <div role="option" aria-selected={false} data-worktree-id={worktreeId}>
          <div data-worktree-context-menu-scope>
            <div data-worktree-card-surface>
              <WorktreeCardAgents worktreeId={worktreeId} />
              <div data-worktree-lineage-children>
                <div role="option" aria-selected={false} data-worktree-id="child" />
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  })
  const sidebar = host.querySelector<HTMLElement>('[data-worktree-sidebar]')!
  const option = sidebar.querySelector<HTMLElement>('[role=option]')!
  const boundary = option.querySelector<HTMLElement>('[data-worktree-lineage-children]')!
  Object.defineProperty(sidebar, 'clientHeight', { value: 673 })
  sidebar.getBoundingClientRect = () => new DOMRect(0, 0, 300, 673)
  option.getBoundingClientRect = () => new DOMRect(0, 200 - sidebar.scrollTop, 300, 11800)
  boundary.getBoundingClientRect = () =>
    new DOMRect(
      0,
      (summaryButton(host).getAttribute('aria-expanded') === 'true' ? 820 : 320) -
        sidebar.scrollTop,
      300,
      11180
    )
  sidebar.scrollTo = vi.fn((options?: ScrollToOptions | number) => {
    if (typeof options === 'object') {
      sidebar.scrollTop = options.top ?? 0
    }
  })
  return host
}

function summaryButton(host: HTMLElement): HTMLButtonElement {
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
    vi.useRealTimers()
  })

  it('reveals expanded own agents without the workspace tail, and does not reveal cached remounts', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
    const host = await mountAgents('wt-remount')
    const sidebar = host.querySelector<HTMLElement>('[data-worktree-sidebar]')!
    const option = sidebar.querySelector<HTMLElement>('[role=option]')!
    const scroll = sidebar.scrollTo
    expect(summaryButton(host).getAttribute('aria-expanded')).toBe('false')

    await act(async () => {
      summaryButton(host).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(summaryButton(host).getAttribute('aria-expanded')).toBe('true')
    const agents = host.querySelector<HTMLElement>('.compact-agent-expansion-content')!
    agents.getBoundingClientRect = () => new DOMRect(0, 320 - sidebar.scrollTop, 300, 490)
    expect(agents.getBoundingClientRect().bottom).toBeGreaterThan(sidebar.clientHeight)
    expect(scroll).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(16)
    })
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 147, behavior: 'auto' })
    expect(agents.getBoundingClientRect().top).toBeGreaterThanOrEqual(0)
    expect(agents.getBoundingClientRect().bottom).toBeLessThanOrEqual(sidebar.clientHeight)
    expect(option.getBoundingClientRect().bottom).toBeGreaterThan(sidebar.clientHeight)

    // Fully remount the same worktree as virtualizer recycling or child-worktree toggles do.
    await act(async () => {
      const first = mountedRoots.shift()!
      first.root.unmount()
      first.host.remove()
    })
    const remounted = await mountAgents('wt-remount')
    const remountScroll = remounted.querySelector<HTMLElement>('[data-worktree-sidebar]')!.scrollTo
    await act(async () => {
      vi.advanceTimersByTime(16)
    })
    expect(summaryButton(remounted).getAttribute('aria-expanded')).toBe('true')
    expect(remountScroll).not.toHaveBeenCalled()
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
