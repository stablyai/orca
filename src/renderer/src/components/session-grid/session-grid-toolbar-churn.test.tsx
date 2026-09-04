// @vitest-environment happy-dom

/**
 * The toolbar re-renders are the page's most expensive constant cost, so this pins the
 * thing that keeps them affordable: an agent-status burst must reach the cards and
 * stop at the toolbar. Both halves are needed and neither shows up alone — the memo on
 * `SessionGridToolbar` does nothing while the builder hands out fresh `filterOptions`,
 * and stabilising those does nothing while the page re-renders an unmemoized child.
 */
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactVirtual from '@tanstack/react-virtual'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useAppStore } from '@/store'
import SessionsGridPage from './SessionsGridPage'
import { livePtyIdsFor } from './session-grid-test-live-ptys'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

vi.mock('@tanstack/react-virtual', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactVirtual>()),
  useVirtualizer: (options: { count: number; estimateSize: (index: number) => number }) => ({
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: index,
        start: index * options.estimateSize(index),
        size: options.estimateSize(index)
      })),
    getTotalSize: () => options.count * options.estimateSize(0),
    measure: () => {}
  })
}))

// Two render counters, one on each side of the memo. The view menu renders once per
// toolbar render; the preview renders once per card render.
const renders = vi.hoisted(() => ({ toolbar: 0, cards: 0 }))

vi.mock('./SessionGridViewMenu', () => ({
  SessionGridViewMenu: ({ hiddenCount }: { hiddenCount: number }) => {
    renders.toolbar += 1
    return <div data-testid="mock-view-menu" data-hidden-count={hiddenCount} />
  },
  SessionGridZoomStepper: () => null
}))
vi.mock('../dashboard-popout/AgentTerminalPreview', () => ({
  AgentTerminalPreview: ({ ptyId }: { ptyId: string }) => {
    renders.cards += 1
    return <div data-testid="mock-terminal-preview" data-pty-id={ptyId} />
  }
}))

function seed(): void {
  const tabsByWorktree: Record<string, TerminalTab[]> = {
    'wt-1': [
      { id: 'tab-1', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'One', createdAt: 1 },
      { id: 'tab-2', ptyId: 'pty-2', worktreeId: 'wt-1', title: 'Two', createdAt: 2 }
    ] as TerminalTab[]
  }
  useAppStore.setState({
    activeView: 'sessions',
    repos: [{ id: 'repo-1', displayName: 'sytio', path: '/code/sytio' } as unknown as Repo],
    worktreesByRepo: {
      'repo-1': [{ id: 'wt-1', displayName: 'sytio', branch: 'main' } as unknown as Worktree]
    },
    tabsByWorktree,
    ptyIdsByTabId: livePtyIdsFor(tabsByWorktree),
    terminalLayoutsByTabId: {},
    folderWorkspaces: [],
    projectGroups: [],
    sessionsGridPreset: '2x2',
    sessionsGridZoom: 1,
    sessionsGridShowEmpty: false,
    sessionsGridFilter: 'all',
    sessionsGridStateFilter: 'all',
    sessionsGridTabOrder: [],
    sessionsGridHiddenTabIds: [],
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0
  })
}

/** A burst that replaces the status map and bumps the epoch without moving a single card. */
function burst(epoch: number): void {
  act(() => {
    useAppStore.setState({ agentStatusByPaneKey: {}, agentStatusEpoch: epoch })
  })
}

describe('session grid toolbar churn', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    renders.toolbar = 0
    renders.cards = 0
    seed()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('lets a status burst through to the cards and stops it at the toolbar', () => {
    render(<SessionsGridPage />)
    expect(screen.getAllByTestId('mock-terminal-preview')).toHaveLength(2)
    const toolbarBefore = renders.toolbar
    const cardsBefore = renders.cards
    expect(toolbarBefore).toBeGreaterThan(0)

    burst(1)
    burst(2)
    burst(3)

    // The burst really did reach the page — the cards re-rendered through their own
    // subscriptions — so a flat toolbar count is the memo working, not a dead test.
    expect(renders.cards).toBeGreaterThan(cardsBefore)
    expect(renders.toolbar).toBe(toolbarBefore)
  })

  it('still re-renders the toolbar when a count it shows actually changes', () => {
    render(<SessionsGridPage />)
    const toolbarBefore = renders.toolbar

    act(() => useAppStore.getState().toggleSessionsGridHiddenTab('tab-1'))

    expect(renders.toolbar).toBeGreaterThan(toolbarBefore)
    expect(screen.getAllByTestId('mock-terminal-preview')).toHaveLength(1)
    expect(screen.getByTestId('mock-view-menu')).toHaveAttribute('data-hidden-count', '1')
  })
})
