// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry, AgentStatusState } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'
import {
  PaletteLiveStatusProvider,
  PaletteRecentTabStatusDot,
  PaletteWorktreeStatusDot
} from './palette-live-status'

vi.mock('@/components/AgentWorkingSpinner', () => ({
  AgentWorkingSpinner: () => <span data-spinner="true" />
}))

const initialAppState = useAppStore.getInitialState()
const LEAF = '11111111-2222-4333-8444-555555555555'

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

function makeAgentEntry(tabId: string, state: AgentStatusState): AgentStatusEntry {
  return {
    state,
    prompt: '',
    updatedAt: Date.now(),
    stateStartedAt: Date.now(),
    paneKey: `${tabId}:${LEAF}`,
    stateHistory: []
  }
}

function setAgentState(state: AgentStatusState): void {
  useAppStore.setState((s) => ({
    agentStatusByPaneKey: { [`term-a:${LEAF}`]: makeAgentEntry('term-a', state) },
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

    await act(async () => {
      setAgentState('blocked')
    })
    expect(dotLabels()).toEqual(['Needs permission'])
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

  it('resolves a live dot for a recent row backed by a terminal', async () => {
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
    expect(dotLabels()).toEqual(['Working'])

    await act(async () => {
      setAgentState('blocked')
    })
    expect(dotLabels()).toEqual(['Needs permission'])
  })
})
