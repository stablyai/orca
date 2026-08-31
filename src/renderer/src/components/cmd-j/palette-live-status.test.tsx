// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry, AgentStatusState } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  PaletteLiveStatusProvider as ProductionPaletteLiveStatusProvider,
  PaletteRecentTabStatusDot,
  PaletteWorktreeStatusDot
} from './palette-live-status'

vi.mock('@/components/AgentWorkingSpinner', () => ({
  AgentWorkingSpinner: () => <span data-spinner="true" />
}))

const initialAppState = useAppStore.getInitialState()
const LEAF = '11111111-2222-4333-8444-555555555555'

function PaletteLiveStatusProvider(
  props: React.ComponentProps<typeof ProductionPaletteLiveStatusProvider>
): React.JSX.Element {
  return (
    <TooltipProvider>
      <ProductionPaletteLiveStatusProvider {...props} />
    </TooltipProvider>
  )
}

let testRoot: Root
let testContainer: HTMLDivElement

function makeTerminalTab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId,
    title: 'Chat',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeAgentEntry(
  tabId: string,
  state: AgentStatusState,
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  return {
    state,
    prompt: '',
    updatedAt: Date.now(),
    stateStartedAt: Date.now(),
    paneKey: makePaneKey(tabId, LEAF),
    stateHistory: [],
    ...overrides
  }
}

function setAgentState(state: AgentStatusState, overrides: Partial<AgentStatusEntry> = {}): void {
  useAppStore.setState((s) => ({
    agentStatusByPaneKey: {
      [makePaneKey('term-a', LEAF)]: makeAgentEntry('term-a', state, overrides)
    },
    agentStatusEpoch: s.agentStatusEpoch + 1
  }))
}

/** Stands in for the palette body: counts how often the frozen subtree is re-rendered. */
let bodyRenderCount = 0
const FrozenBody = React.memo(function FrozenBody({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  bodyRenderCount += 1
  return <>{children}</>
})

function dotLabels(): string[] {
  return [...testContainer.querySelectorAll<HTMLElement>('.sr-only')].map(
    (node) => node.textContent ?? ''
  )
}

function expectStyledStatusTooltip(label: string): void {
  const trigger = testContainer.querySelector<HTMLElement>('[data-slot="tooltip-trigger"]')
  expect(trigger).not.toBeNull()
  expect(trigger?.getAttribute('title')).toBeNull()
  expect(trigger?.textContent).toContain(label)
}

describe('palette live status', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    bodyRenderCount = 0
    useAppStore.setState(initialAppState, true)
    useAppStore.setState({
      tabsByWorktree: { 'wt-a': [makeTerminalTab('term-a', 'wt-a')] },
      ptyIdsByTabId: { 'term-a': ['pty-term-a'] },
      browserTabsByWorktree: {}
    } as Partial<AppState>)
    testContainer = document.createElement('div')
    document.body.appendChild(testContainer)
    testRoot = createRoot(testContainer)
  })

  afterEach(async () => {
    await act(async () => {
      testRoot.unmount()
    })
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
  })

  async function render(active = true): Promise<void> {
    await act(async () => {
      testRoot.render(
        <PaletteLiveStatusProvider active={active}>
          <FrozenBody>
            <PaletteWorktreeStatusDot worktree={{ id: 'wt-a' }} />
          </FrozenBody>
        </PaletteLiveStatusProvider>
      )
    })
  }

  it('updates a worktree dot when the agent transitions', async () => {
    setAgentState('working')
    await render()
    expect(dotLabels()).toEqual(['Working'])
    expect(testContainer.querySelector('[data-slot="tooltip-trigger"]')).not.toBeNull()

    await act(async () => {
      setAgentState('blocked')
    })
    expect(dotLabels()).toEqual(['Needs permission'])
  })

  it('shows monitoring when a covered pane retains a working title', async () => {
    setAgentState('working', { workingMode: 'monitoring' })
    useAppStore.setState({
      tabsByWorktree: {
        'wt-a': [{ ...makeTerminalTab('term-a', 'wt-a'), title: 'claude [working]' }]
      }
    } as Partial<AppState>)

    await render()

    expect(testContainer.querySelector('[data-spinner]')).toBeNull()
    expect(testContainer.querySelector('.lucide-activity')?.classList).toContain('text-yellow-500')
    expect(dotLabels()).toEqual(['Monitoring background tasks'])
  })

  // Why this is the whole point: the palette body no longer subscribes to agent status, so if the
  // dot didn't hold its own subscription it would freeze at whatever it showed when you opened.
  it('re-renders the dot without re-rendering the frozen body around it', async () => {
    setAgentState('working')
    await render()
    const rendersAfterMount = bodyRenderCount

    await act(async () => {
      setAgentState('blocked')
    })

    expect(dotLabels()).toEqual(['Needs permission'])
    expect(bodyRenderCount).toBe(rendersAfterMount)
  })

  // Why: unread writes are app-wide chatter. The pip owns them here so the palette body can read
  // its unread from the open-time snapshot instead of re-rendering the whole list on every bell.
  it('re-renders the unread pip without re-rendering the frozen body around it', async () => {
    await act(async () => {
      testRoot.render(
        <PaletteLiveStatusProvider active>
          <FrozenBody>
            <PaletteRecentTabStatusDot
              row={{
                id: 'workspace-tab:tab-a',
                worktreeId: 'wt-a',
                unifiedTabId: 'tab-a',
                terminalTab: { id: 'term-a', title: 'Chat' },
                worktreeLastActivityAt: 0
              }}
              fallback={<span data-fallback="true" />}
            />
          </FrozenBody>
        </PaletteLiveStatusProvider>
      )
    })
    const rendersAfterMount = bodyRenderCount

    await act(async () => {
      useAppStore.setState({ unreadTerminalTabs: { 'term-a': true } } as Partial<AppState>)
    })

    expect(dotLabels()).toEqual(['Unread agent completion'])
    expect(bodyRenderCount).toBe(rendersAfterMount)
  })

  it('goes inert while the palette is closed', async () => {
    setAgentState('working')
    await render(false)
    // No live maps flow through, so the dot falls back to the no-tabs state rather than
    // reporting a worktree it isn't watching.
    expect(dotLabels()).toEqual(['Inactive'])
  })

  it('falls back to the row icon when a recent row has no terminal behind it', async () => {
    await act(async () => {
      testRoot.render(
        <PaletteLiveStatusProvider active>
          <PaletteRecentTabStatusDot
            row={{
              id: 'workspace-tab:tab-a',
              worktreeId: 'wt-a',
              unifiedTabId: 'tab-a',
              terminalTab: null,
              worktreeLastActivityAt: 0
            }}
            fallback={<span data-fallback="true" />}
          />
        </PaletteLiveStatusProvider>
      )
    })
    expect(testContainer.querySelector('[data-fallback]')).not.toBeNull()
    expect(dotLabels()).toEqual([])
  })

  it('badges only working and permission — not quiet active — on terminal-backed rows', async () => {
    // Live PTY, no agent activity → active, but quiet chats stay icon-only (no emerald pip).
    await act(async () => {
      testRoot.render(
        <PaletteLiveStatusProvider active>
          <PaletteRecentTabStatusDot
            row={{
              id: 'workspace-tab:tab-a',
              worktreeId: 'wt-a',
              unifiedTabId: 'tab-a',
              terminalTab: { id: 'term-a', title: 'Chat' },
              worktreeLastActivityAt: 0
            }}
            fallback={<span data-fallback="true" />}
          />
        </PaletteLiveStatusProvider>
      )
    })
    expect(testContainer.querySelector('[data-fallback]')).not.toBeNull()
    expect(dotLabels()).toEqual([])
    expect(testContainer.querySelector('[data-spinner]')).toBeNull()

    await act(async () => {
      setAgentState('working')
    })
    // Why: A2 — category identity stays on the content icon; only high-signal agent states get a pip.
    expect(testContainer.querySelector('[data-fallback]')).not.toBeNull()
    expect(testContainer.querySelector('[data-spinner]')).not.toBeNull()
    expect(dotLabels()).toEqual(['Working'])
    expectStyledStatusTooltip('Working')

    await act(async () => {
      setAgentState('blocked')
    })
    expect(testContainer.querySelector('[data-fallback]')).not.toBeNull()
    expect(testContainer.querySelector('[data-spinner]')).toBeNull()
    expect(dotLabels()).toEqual(['Needs permission'])
    expectStyledStatusTooltip('Needs permission')
  })

  it('shows monitoring with a static radio instead of the working spinner', async () => {
    setAgentState('working', { workingMode: 'monitoring' })
    await act(async () => {
      testRoot.render(
        <PaletteLiveStatusProvider active>
          <PaletteRecentTabStatusDot
            row={{
              id: 'workspace-tab:tab-a',
              worktreeId: 'wt-a',
              unifiedTabId: 'tab-a',
              terminalTab: { id: 'term-a', title: 'Chat' },
              worktreeLastActivityAt: 0
            }}
            fallback={<span data-fallback="true" />}
          />
        </PaletteLiveStatusProvider>
      )
    })

    expect(testContainer.querySelector('[data-spinner]')).toBeNull()
    expect(testContainer.querySelector('.lucide-activity')?.classList).toContain('text-yellow-500')
    expect(dotLabels()).toEqual(['Monitoring background tasks'])
    expectStyledStatusTooltip('Monitoring background tasks')
  })

  it('shows only the content icon when a terminal-backed row is inactive', async () => {
    useAppStore.setState({
      ptyIdsByTabId: {}
    } as Partial<AppState>)
    await act(async () => {
      testRoot.render(
        <PaletteLiveStatusProvider active>
          <PaletteRecentTabStatusDot
            row={{
              id: 'workspace-tab:tab-a',
              worktreeId: 'wt-a',
              unifiedTabId: 'tab-a',
              terminalTab: { id: 'term-a', title: 'Chat' },
              worktreeLastActivityAt: 0
            }}
            fallback={<span data-fallback="true" />}
          />
        </PaletteLiveStatusProvider>
      )
    })
    expect(testContainer.querySelector('[data-fallback]')).not.toBeNull()
    expect(dotLabels()).toEqual([])
    expect(testContainer.querySelector('[data-spinner]')).toBeNull()
  })

  it('badges unread agent completion when the agent is quiet', async () => {
    useAppStore.setState({
      unreadAgentCompletionPanes: {
        [makePaneKey('term-a', LEAF)]: true
      }
    } as Partial<AppState>)
    await act(async () => {
      testRoot.render(
        <PaletteLiveStatusProvider active>
          <PaletteRecentTabStatusDot
            row={{
              id: 'workspace-tab:tab-a',
              worktreeId: 'wt-a',
              unifiedTabId: 'tab-a',
              terminalTab: { id: 'term-a', title: 'Chat' },
              worktreeLastActivityAt: 0
            }}
            fallback={<span data-fallback="true" />}
          />
        </PaletteLiveStatusProvider>
      )
    })
    expect(testContainer.querySelector('[data-fallback]')).not.toBeNull()
    expect(testContainer.querySelector('[data-spinner]')).toBeNull()
    expect(dotLabels()).toEqual(['Unread agent completion'])
    expectStyledStatusTooltip('Unread agent completion')
  })

  it('prefers working over unread on the same row', async () => {
    setAgentState('working')
    useAppStore.setState({
      unreadTerminalTabs: { 'term-a': true }
    } as Partial<AppState>)
    await act(async () => {
      testRoot.render(
        <PaletteLiveStatusProvider active>
          <PaletteRecentTabStatusDot
            row={{
              id: 'workspace-tab:tab-a',
              worktreeId: 'wt-a',
              unifiedTabId: 'tab-a',
              terminalTab: { id: 'term-a', title: 'Chat' },
              worktreeLastActivityAt: 0
            }}
            fallback={<span data-fallback="true" />}
          />
        </PaletteLiveStatusProvider>
      )
    })
    expect(testContainer.querySelector('[data-spinner]')).not.toBeNull()
    expect(dotLabels()).toEqual(['Working'])
  })

  it('badges freshly done with a check when quiet and not unread', async () => {
    setAgentState('done')
    await act(async () => {
      testRoot.render(
        <PaletteLiveStatusProvider active>
          <PaletteRecentTabStatusDot
            row={{
              id: 'workspace-tab:tab-a',
              worktreeId: 'wt-a',
              unifiedTabId: 'tab-a',
              terminalTab: { id: 'term-a', title: 'Chat' },
              worktreeLastActivityAt: 0
            }}
            fallback={<span data-fallback="true" />}
          />
        </PaletteLiveStatusProvider>
      )
    })
    expect(testContainer.querySelector('[data-fallback]')).not.toBeNull()
    expect(dotLabels()).toEqual(['Done'])
    expectStyledStatusTooltip('Done')
    // lucide CircleCheck class marker
    expect(testContainer.innerHTML).toContain('lucide-circle-check')
  })

  it('prefers unread over freshly done on the same row', async () => {
    setAgentState('done')
    useAppStore.setState({
      unreadTerminalTabs: { 'term-a': true }
    } as Partial<AppState>)
    await act(async () => {
      testRoot.render(
        <PaletteLiveStatusProvider active>
          <PaletteRecentTabStatusDot
            row={{
              id: 'workspace-tab:tab-a',
              worktreeId: 'wt-a',
              unifiedTabId: 'tab-a',
              terminalTab: { id: 'term-a', title: 'Chat' },
              worktreeLastActivityAt: 0
            }}
            fallback={<span data-fallback="true" />}
          />
        </PaletteLiveStatusProvider>
      )
    })
    expect(dotLabels()).toEqual(['Unread agent completion'])
    expect(testContainer.innerHTML).not.toContain('lucide-circle-check')
  })

  it('prefers permission over unread on the same row', async () => {
    setAgentState('blocked')
    useAppStore.setState({
      unreadTerminalTabs: { 'term-a': true }
    } as Partial<AppState>)
    await act(async () => {
      testRoot.render(
        <PaletteLiveStatusProvider active>
          <PaletteRecentTabStatusDot
            row={{
              id: 'workspace-tab:tab-a',
              worktreeId: 'wt-a',
              unifiedTabId: 'tab-a',
              terminalTab: { id: 'term-a', title: 'Chat' },
              worktreeLastActivityAt: 0
            }}
            fallback={<span data-fallback="true" />}
          />
        </PaletteLiveStatusProvider>
      )
    })
    expect(dotLabels()).toEqual(['Needs permission'])
  })

  it('cuts the pip out of the dialog surface, and out of accent when selected', async () => {
    setAgentState('working')
    await act(async () => {
      testRoot.render(
        <PaletteLiveStatusProvider active>
          <PaletteRecentTabStatusDot
            row={{
              id: 'workspace-tab:tab-a',
              worktreeId: 'wt-a',
              unifiedTabId: 'tab-a',
              terminalTab: { id: 'term-a', title: 'Chat' },
              worktreeLastActivityAt: 0
            }}
            fallback={<span data-fallback="true" />}
          />
        </PaletteLiveStatusProvider>
      )
    })
    const pip = testContainer.querySelector<HTMLElement>('[aria-hidden="true"].rounded-full')
    expect(pip).not.toBeNull()
    // Why popover and not background: the CommandDialog surface is --popover (#171717 dark), while
    // --background is the app canvas (#0a0a0a) — the mismatch punched a dark halo through each row.
    expect(pip?.className).toContain('bg-popover')
    expect(pip?.className).toContain('ring-popover')
    expect(pip?.className).not.toContain('bg-background')
    expect(pip?.className).toContain(
      'group-data-[selected=true]:bg-[var(--jump-palette-selection-surface)]'
    )
    expect(pip?.className).toContain(
      'group-data-[selected=true]:ring-[var(--jump-palette-selection-surface)]'
    )
  })
})
