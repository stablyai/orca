// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactVirtual from '@tanstack/react-virtual'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useAppStore } from '@/store'
import { readStoreListenerCount } from '@/store/store-listener-census'
import SessionsGridPage from './SessionsGridPage'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { Repo } from '../../../../shared/repo-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { livePtyIdsFor } from './session-grid-test-live-ptys'

// happy-dom lays nothing out, so the virtualizer would report an empty range.
// Every row is in range here; the range extractor has its own unit test.
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

const previewHarness = vi.hoisted(() => ({
  ptyGoneByPtyId: new Map<string, () => void>()
}))
const backgroundMountHarness = vi.hoisted(() => ({
  request: vi.fn()
}))

vi.mock('../dashboard-popout/AgentTerminalPreview', () => ({
  AgentTerminalPreview: ({ ptyId, onPtyGone }: { ptyId: string; onPtyGone?: () => void }) => {
    if (onPtyGone) {
      previewHarness.ptyGoneByPtyId.set(ptyId, onPtyGone)
    }
    return <div data-testid="mock-terminal-preview" data-pty-id={ptyId} />
  }
}))
vi.mock('@/components/terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: backgroundMountHarness.request
}))

function cardAttentionBadge(tabId: string): string | null {
  return (
    document
      .querySelector(`[data-tab-id="${tabId}"] [data-attention-badge]`)
      ?.getAttribute('data-attention-badge') ?? null
  )
}

// The toolbar's icon-only launcher is aria-labelled "New session"; the empty
// state's is labelled by its own text, so an exact name keeps the two apart.
function emptyStateLaunchButton(): HTMLElement {
  return screen.getByRole('button', { name: 'New Session' })
}

function emptyState(): HTMLElement {
  return screen.getByTestId('session-grid-empty-state')
}

/** Bare shells in one workspace: no agent status, so every card lands in the `idle` bucket. */
function seedShells(count: number): void {
  const tabsByWorktree: Record<string, TerminalTab[]> = {
    'wt-1': Array.from({ length: count }, (_, i) => ({
      id: `tab-${i}`,
      ptyId: `pty-${i}`,
      worktreeId: 'wt-1',
      title: `Session ${i}`,
      createdAt: i
    })) as TerminalTab[]
  }
  useAppStore.setState({
    repos: [{ id: 'repo-1', displayName: 'sytio', path: '/code/sytio' } as unknown as Repo],
    worktreesByRepo: {
      'repo-1': [{ id: 'wt-1', displayName: 'sytio', branch: 'main' } as unknown as Worktree]
    },
    tabsByWorktree,
    ptyIdsByTabId: livePtyIdsFor(tabsByWorktree)
  })
}

describe('SessionsGridPage', () => {
  beforeEach(() => {
    // Staged mounting admits one terminal per frame; run the frames synchronously.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    useAppStore.setState({
      activeView: 'sessions',
      sessionsGridFilter: 'all',
      sessionsGridPreset: '2x2',
      sessionsGridZoom: 1,
      sessionsGridShowEmpty: true,
      activeSessionGridTabId: null,
      sessionsGridStateFilter: 'all',
      sessionsGridHiddenTabIds: [],
      repos: [],
      worktreesByRepo: {},
      folderWorkspaces: [],
      projectGroups: [],
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {},
      unreadTerminalTabs: {},
      unreadAgentCompletionPanes: {}
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    previewHarness.ptyGoneByPtyId.clear()
    backgroundMountHarness.request.mockClear()
  })

  it('respawns a card whose pty the last run left behind, and admits defeat after the grace', () => {
    // Only timeouts: the staged mount runs on the synchronous rAF stub above.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const tabsByWorktree: Record<string, TerminalTab[]> = {
      'wt-1': [
        { id: 'tab-1', ptyId: 'pty-stale', worktreeId: 'wt-1', title: 'Agent', createdAt: 100 }
      ] as TerminalTab[]
    }
    useAppStore.setState({
      repos: [{ id: 'repo-1', displayName: 'sytio', path: '/code/sytio' } as unknown as Repo],
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', displayName: 'sytio', branch: 'main' } as unknown as Worktree]
      },
      tabsByWorktree,
      ptyIdsByTabId: livePtyIdsFor(tabsByWorktree)
    })
    render(<SessionsGridPage />)
    expect(screen.getByTestId('mock-terminal-preview')).toHaveAttribute('data-pty-id', 'pty-stale')

    // Main knows no such pty: the card asks for the tab's pane to mount and shows the session starting.
    act(() => previewHarness.ptyGoneByPtyId.get('pty-stale')!())
    expect(backgroundMountHarness.request).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabIds: ['tab-1']
    })
    expect(screen.queryByTestId('mock-terminal-preview')).toBeNull()
    expect(screen.getByText('Starting session…')).toBeInTheDocument()

    // The mount binds a fresh pty: the preview comes back on it.
    act(() => {
      useAppStore.setState({
        tabsByWorktree: { 'wt-1': [{ ...tabsByWorktree['wt-1']![0]!, ptyId: 'pty-fresh' }] },
        ptyIdsByTabId: { 'tab-1': ['pty-fresh'] }
      })
    })
    expect(screen.getByTestId('mock-terminal-preview')).toHaveAttribute('data-pty-id', 'pty-fresh')

    // A pty that never gets replaced: after the grace the preview remounts and, told
    // again, the card leaves the "closed" verdict to it instead of asking twice.
    act(() => {
      useAppStore.setState({
        tabsByWorktree,
        ptyIdsByTabId: livePtyIdsFor(tabsByWorktree)
      })
    })
    act(() => previewHarness.ptyGoneByPtyId.get('pty-stale')!())
    expect(screen.queryByTestId('mock-terminal-preview')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(15_000)
    })
    expect(screen.getByTestId('mock-terminal-preview')).toHaveAttribute('data-pty-id', 'pty-stale')
    act(() => previewHarness.ptyGoneByPtyId.get('pty-stale')!())
    expect(screen.getByTestId('mock-terminal-preview')).toHaveAttribute('data-pty-id', 'pty-stale')
    expect(backgroundMountHarness.request).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('renders empty state when there are no active sessions', () => {
    render(<SessionsGridPage />)
    expect(emptyState()).toHaveAttribute('data-reason', 'no-sessions')
    expect(emptyStateLaunchButton()).toBeInTheDocument()
  })

  /**
   * The screen said "No active sessions" while the toolbar beside it showed a lit chip and
   * a "Hidden N" pill proving otherwise, and offered to create another session the user did
   * not need. Three different situations, three answers — and the offer has to be the one
   * that actually brings the cards back.
   */
  it('blames the state chip, and offers to clear it rather than open another session', () => {
    seedShells(2)
    useAppStore.setState({ sessionsGridStateFilter: 'working' })

    render(<SessionsGridPage />)

    expect(screen.queryAllByTestId('session-grid-card')).toHaveLength(0)
    expect(emptyState()).toHaveAttribute('data-reason', 'filtered')
    expect(screen.queryByRole('button', { name: 'New Session' })).toBeNull()

    fireEvent.click(screen.getByTestId('session-grid-empty-clear-filters'))

    expect(useAppStore.getState().sessionsGridStateFilter).toBe('all')
    expect(screen.getAllByTestId('session-grid-card')).toHaveLength(2)
  })

  it('blames hiding, and offers the reveal that brings them back', () => {
    seedShells(1)
    useAppStore.setState({ sessionsGridHiddenTabIds: ['tab-0'] })

    render(<SessionsGridPage />)

    expect(emptyState()).toHaveAttribute('data-reason', 'hidden')
    expect(screen.queryByRole('button', { name: 'New Session' })).toBeNull()

    fireEvent.click(screen.getByTestId('session-grid-empty-reveal-hidden'))

    expect(screen.getAllByTestId('session-grid-card')).toHaveLength(1)
  })

  it('offers the workspace picker from the empty state when no workspace is active', () => {
    useAppStore.setState({
      activeWorktreeId: null,
      repos: [{ id: 'repo-1', displayName: 'sytio', path: '/code/sytio' } as unknown as Repo],
      worktreesByRepo: {
        'repo-1': [
          { id: 'wt-1', displayName: 'sytio', branch: 'solidez/base' } as unknown as Worktree
        ]
      }
    })
    render(<SessionsGridPage />)
    const launch = emptyStateLaunchButton()
    // A popover trigger, not a click handler with nothing to launch into.
    expect(launch).toHaveAttribute('aria-haspopup', 'dialog')
    expect(launch).toBeEnabled()
  })

  it('disables the empty-state launcher when there is no workspace to launch into', () => {
    useAppStore.setState({ activeWorktreeId: null, repos: [], worktreesByRepo: {} })
    render(<SessionsGridPage />)
    expect(emptyStateLaunchButton()).toBeDisabled()
  })

  it('disables it for a repo group that holds no workspace, which the menu cannot offer', () => {
    useAppStore.setState({
      activeWorktreeId: null,
      repos: [{ id: 'repo-1', displayName: 'sytio', path: '/code/sytio' } as unknown as Repo],
      worktreesByRepo: { 'repo-1': [] }
    })
    render(<SessionsGridPage />)
    expect(emptyStateLaunchButton()).toBeDisabled()
  })

  it('enables it on a folder-only install, whose workspaces live outside worktreesByRepo', () => {
    useAppStore.setState({
      activeWorktreeId: null,
      repos: [],
      worktreesByRepo: {},
      folderWorkspaces: [
        {
          id: 'fw-1',
          projectGroupId: 'group-1',
          name: 'notes',
          folderPath: '/dev/notes'
        } as unknown as FolderWorkspace
      ],
      projectGroups: [{ id: 'group-1', name: 'Folders' } as unknown as ProjectGroup]
    })
    render(<SessionsGridPage />)
    expect(emptyStateLaunchButton()).toBeEnabled()
  })

  it('renders session cards and empty slots for 2x2 grid when 3 sessions exist', () => {
    const repos: Repo[] = [
      { id: 'repo-1', displayName: 'sytio', path: '/code/sytio' } as unknown as Repo
    ]
    const worktreesByRepo: Record<string, Worktree[]> = {
      'repo-1': [
        { id: 'wt-1', displayName: 'sytio', branch: 'solidez/base' } as unknown as Worktree
      ]
    }
    const tabsByWorktree: Record<string, TerminalTab[]> = {
      'wt-1': [
        {
          id: 'tab-1',
          ptyId: 'pty-1',
          worktreeId: 'wt-1',
          title: 'Base de conocimiento contrato 21%',
          createdAt: 100
        } as TerminalTab,
        {
          id: 'tab-2',
          ptyId: 'pty-2',
          worktreeId: 'wt-1',
          title: 'Session',
          createdAt: 200
        } as TerminalTab,
        {
          id: 'tab-3',
          ptyId: 'pty-3',
          worktreeId: 'wt-1',
          title: 'Term 3',
          createdAt: 300
        } as TerminalTab
      ]
    }

    useAppStore.setState({
      repos,
      worktreesByRepo,
      tabsByWorktree,
      ptyIdsByTabId: livePtyIdsFor(tabsByWorktree),
      sessionsGridPreset: '2x2',
      sessionsGridShowEmpty: true
    })

    render(<SessionsGridPage />)

    // Every card names its session; the workspace identity is a separate, shared spelling.
    expect(
      screen.getAllByTestId('session-grid-card-session').map((node) => node.textContent)
    ).toEqual(['Base de conocimiento contrato 21%', 'Session', 'Term 3'])

    // Terminal previews
    const previews = screen.getAllByTestId('mock-terminal-preview')
    expect(previews).toHaveLength(3)

    // One slot finishes the row and a full trailing row is always kept, so a
    // new session has somewhere to land without changing preset.
    expect(screen.getAllByText('New Session')).toHaveLength(3)

    // Clicking anywhere on the card opens the menu, and it opens at the click
    // point rather than against the card's bounding box: a nested trigger used
    // to re-toggle the menu shut, and a card-anchored menu flipped sides on the
    // last row. Radix does not portal under happy-dom, so this asserts the
    // controlled anchor the content hangs off.
    const slot = screen.getAllByTestId('session-grid-empty-slot')[0]!
    expect(slot.parentElement?.className).toBe('h-full min-h-0 min-w-0')
    const anchor = slot.parentElement!.querySelector<HTMLElement>('[aria-haspopup="dialog"]')!
    expect(anchor).not.toBe(slot)
    expect(anchor).toHaveAttribute('data-state', 'closed')

    fireEvent.pointerDown(slot)
    fireEvent.click(slot, { clientX: 120, clientY: 240 })

    expect(anchor).toHaveAttribute('data-state', 'open')
    expect(anchor.style.left).toBe('120px')
    expect(anchor.style.top).toBe('240px')

    // Clicking the card again closes it. The card is no longer the trigger, so
    // Radix dismisses on the pointerdown and the click would otherwise reopen.
    fireEvent.pointerDown(slot)
    fireEvent.click(slot, { clientX: 130, clientY: 250 })

    expect(anchor).toHaveAttribute('data-state', 'closed')
  })

  /**
   * Zustand visits every listener on every publication, so an agent-status burst costs
   * `events x listeners x cards` (docs/reference/renderer-agent-status-performance.md).
   * The page's own budget is pinned by
   * `use-sessions-grid-items.store-subscriptions.test.tsx`; this pins the half that
   * scales — and it has to mount real cards to mean anything.
   */
  it('opens a fixed number of store listeners per card, so the grid scales linearly', () => {
    // Measured as (four cards - one card) / 3: 1 for `useTabAgent`'s bundle
    // (lib/tab-agent-store-signals.ts, reached through session-grid-card-agent.tsx),
    // 3 in SessionGridCard.tsx:73-75 (zoom, wheel target, the whole settings object),
    // 1 in session-grid-card-agent.tsx:13, and the terminal-input bundle in
    // session-grid-card-terminal-input.ts:16.
    const PER_CARD_LISTENERS = 6

    const repos: Repo[] = [
      { id: 'repo-1', displayName: 'sytio', path: '/code/sytio' } as unknown as Repo
    ]
    const worktreesByRepo: Record<string, Worktree[]> = {
      'repo-1': [{ id: 'wt-1', displayName: 'sytio', branch: 'main' } as unknown as Worktree]
    }
    const renderCards = (count: number): void => {
      const tabsByWorktree: Record<string, TerminalTab[]> = {
        'wt-1': Array.from({ length: count }, (_, i) => ({
          id: `tab-${i}`,
          ptyId: `pty-${i}`,
          worktreeId: 'wt-1',
          title: `Session ${i}`,
          createdAt: i
        })) as TerminalTab[]
      }
      useAppStore.setState({
        repos,
        worktreesByRepo,
        tabsByWorktree,
        ptyIdsByTabId: livePtyIdsFor(tabsByWorktree),
        // No empty slots, so the delta below is cards and nothing else.
        sessionsGridShowEmpty: false
      })
      render(<SessionsGridPage />)
    }
    const listeners = (): number => {
      const count = readStoreListenerCount()
      if (count === null) {
        throw new Error('store listener census unavailable')
      }
      return count
    }

    const baseline = listeners()
    renderCards(1)
    expect(screen.getAllByTestId('mock-terminal-preview')).toHaveLength(1)
    const withOneCard = listeners() - baseline

    cleanup()
    expect(listeners()).toBe(baseline)

    renderCards(4)
    expect(screen.getAllByTestId('mock-terminal-preview')).toHaveLength(4)
    const withFourCards = listeners() - baseline

    expect(withFourCards - withOneCard).toBe(3 * PER_CARD_LISTENERS)
  })

  // Located by attribute, not by text: the app boots in the system locale, so an
  // English `getByText` here would pass by accident and rot the day someone translates it.
  it('rings the bell on a card with an unread turn, and only on that card', () => {
    const tabsByWorktree: Record<string, TerminalTab[]> = {
      'wt-1': [
        { id: 'tab-1', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'One', createdAt: 1 },
        { id: 'tab-2', ptyId: 'pty-2', worktreeId: 'wt-1', title: 'Two', createdAt: 2 }
      ] as TerminalTab[]
    }
    useAppStore.setState({
      repos: [{ id: 'repo-1', displayName: 'sytio', path: '/code/sytio' } as unknown as Repo],
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', displayName: 'sytio', branch: 'main' } as unknown as Worktree]
      },
      tabsByWorktree,
      ptyIdsByTabId: livePtyIdsFor(tabsByWorktree),
      unreadTerminalTabs: { 'tab-1': true }
    })

    render(<SessionsGridPage />)

    expect(cardAttentionBadge('tab-1')).toBe('unread')
    expect(cardAttentionBadge('tab-2')).toBe('none')
    // The glyph itself, not just the attribute: amber bell, not the agent-question orange.
    const bell = document.querySelector('[data-tab-id="tab-1"] [data-attention-badge] svg')
    expect(bell?.getAttribute('class')).toContain('text-amber-500')
  })

  it('navigates to tabs view and sets active tab when maximize is clicked', () => {
    const repos: Repo[] = [
      { id: 'repo-1', displayName: 'sytio', path: '/code/sytio' } as unknown as Repo
    ]
    const worktreesByRepo: Record<string, Worktree[]> = {
      'repo-1': [
        { id: 'wt-1', displayName: 'sytio', branch: 'solidez/base' } as unknown as Worktree
      ]
    }
    const tabsByWorktree: Record<string, TerminalTab[]> = {
      'wt-1': [
        {
          id: 'tab-1',
          ptyId: 'pty-1',
          worktreeId: 'wt-1',
          title: 'Term 1',
          createdAt: 100
        } as TerminalTab
      ]
    }

    useAppStore.setState({
      repos,
      worktreesByRepo,
      tabsByWorktree
    })

    render(<SessionsGridPage />)

    const maxBtn = screen.getByRole('button', { name: /maximize to tabs view/i })
    fireEvent.click(maxBtn)

    const state = useAppStore.getState()
    expect(state.activeView).toBe('terminal')
    expect(state.activeWorktreeId).toBe('wt-1')
    expect(state.activeTabId).toBe('tab-1')
  })
})
