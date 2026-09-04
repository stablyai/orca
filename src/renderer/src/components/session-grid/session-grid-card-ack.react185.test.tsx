// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactVirtual from '@tanstack/react-virtual'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useAppStore } from '@/store'
import { useAutoAckViewedAgent } from '@/hooks/useAutoAckViewedAgent'
import SessionsGridPage from './SessionsGridPage'
import { livePtyIdsFor } from './session-grid-test-live-ptys'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'

// happy-dom lays nothing out, so the real virtualizer would report an empty range.
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
vi.mock('../dashboard-popout/AgentTerminalPreview', () => ({
  AgentTerminalPreview: ({ ptyId }: { ptyId: string }) => <div data-pty-id={ptyId} />
}))

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const LEAF_C = '33333333-3333-4333-8333-333333333333'
const PANE_A = makePaneKey('tab-1', LEAF_A)
const SIBLING_PANE = makePaneKey('tab-1', LEAF_B)
const PANE_C = makePaneKey('tab-2', LEAF_C)

// A real worktree id encodes its repo (`repoId::path`); `clearWorktreeUnread` routes on that.
const WT_ID = 'repo-1::/code/sytio/main'
const initialState = useAppStore.getInitialState()

/** Stamped ahead of the local clock: an SSH execution host stamps the turn with its own. */
function doneEntryStampedAhead(paneKey: string): AgentStatusEntry {
  const ahead = Date.now() + 60_000
  return {
    paneKey,
    state: 'done',
    agentType: 'claude',
    prompt: 'turn stamped by the execution host',
    updatedAt: ahead,
    stateStartedAt: ahead,
    stateHistory: [],
    worktreeId: WT_ID
  } as unknown as AgentStatusEntry
}

/** The app-shell pairing: the grid page plus the scan loop that owns the ack. */
function GridWithAutoAck(): React.JSX.Element {
  useAutoAckViewedAgent(false)
  return <SessionsGridPage />
}

/**
 * tab-1 is split (LEAF_A visible, LEAF_B hidden behind it); tab-2 is a second card in the
 * same workspace, unread and never clicked. Everything below is shared state the sidebar,
 * the tab bar, the Dock badge and Activity read too.
 */
function seed(): void {
  const tabsByWorktree: Record<string, TerminalTab[]> = {
    [WT_ID]: [
      { id: 'tab-1', ptyId: 'pty-a', worktreeId: WT_ID, title: 'Split', createdAt: 1 },
      { id: 'tab-2', ptyId: 'pty-c', worktreeId: WT_ID, title: 'Other', createdAt: 2 }
    ] as TerminalTab[]
  }
  useAppStore.setState({
    activeView: 'sessions',
    activeSessionGridTabId: null,
    activeWorktreeId: WT_ID,
    sessionsGridPreset: '2x2',
    sessionsGridShowEmpty: false,
    sessionsGridFilter: 'all',
    sessionsGridStateFilter: 'all',
    sessionsGridTabOrder: [],
    sessionsGridHiddenTabIds: [],
    repos: [{ id: 'repo-1', displayName: 'sytio', path: '/code/sytio' } as unknown as Repo],
    worktreesByRepo: {
      'repo-1': [
        {
          id: WT_ID,
          repoId: 'repo-1',
          path: '/code/sytio/main',
          displayName: 'sytio',
          branch: 'main',
          isUnread: true
        } as unknown as Worktree
      ]
    },
    tabsByWorktree,
    ptyIdsByTabId: { 'tab-1': ['pty-a', 'pty-b'], 'tab-2': ['pty-c'] },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: null,
        activeLeafId: LEAF_A,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_A]: 'pty-a', [LEAF_B]: 'pty-b' }
      },
      'tab-2': {
        root: null,
        activeLeafId: LEAF_C,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_C]: 'pty-c' }
      }
    } as never,
    agentStatusByPaneKey: {
      [PANE_A]: doneEntryStampedAhead(PANE_A),
      [SIBLING_PANE]: doneEntryStampedAhead(SIBLING_PANE),
      [PANE_C]: doneEntryStampedAhead(PANE_C)
    },
    agentStatusEpoch: 1,
    unreadAgentCompletionPanes: { [PANE_A]: true, [SIBLING_PANE]: true, [PANE_C]: true },
    unreadTerminalTabs: { 'tab-1': true, 'tab-2': true },
    acknowledgedAgentsByPaneKey: {},
    manuallyUnreadTurnsByPaneKey: {}
  })
  void livePtyIdsFor(tabsByWorktree)
}

function clickCard(tabId: string): void {
  const card = document.querySelector<HTMLElement>(`[data-tab-id="${tabId}"]`)
  expect(card).not.toBeNull()
  fireEvent.click(card!)
}

function countWritesTo(key: 'acknowledgedAgentsByPaneKey' | 'unreadTerminalTabs'): {
  readonly count: () => number
  stop: () => void
} {
  // Why track the last reference instead of comparing (next, prev): the ack runs inside
  // another listener's notification, so the outer loop replays the pre-ack `prev` to every
  // later listener and a naive diff double-counts one write.
  let last: unknown = useAppStore.getState()[key]
  let writes = 0
  const stop = useAppStore.subscribe((next) => {
    if (next[key] !== last) {
      writes += 1
      last = next[key]
    }
  })
  return { count: () => writes, stop }
}

describe('session-grid card ack (React #185)', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    useAppStore.setState(initialState, true)
    seed()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    useAppStore.setState(initialState, true)
  })

  /**
   * The loop this guards: the scan writes, the write republishes, the scan runs again.
   * It only terminates because `acknowledgeAgents` stamps `max(now, turn)` — with a turn
   * stamped by a remote host's clock, a plain `now` would leave `ackAt < stateStartedAt`
   * true forever and re-enter until the stack gives out.
   */
  it('acks the clicked card exactly once, even with a turn stamped ahead of the local clock', () => {
    render(<GridWithAutoAck />)
    const ackWrites = countWritesTo('acknowledgedAgentsByPaneKey')

    try {
      clickCard('tab-1')
    } finally {
      ackWrites.stop()
    }

    expect(ackWrites.count()).toBe(1)
    expect(useAppStore.getState().acknowledgedAgentsByPaneKey[PANE_A]).toBeGreaterThanOrEqual(
      useAppStore.getState().agentStatusByPaneKey[PANE_A]!.stateStartedAt
    )
  })

  it('settles: no further ack writes once the click has been handled', () => {
    render(<GridWithAutoAck />)
    clickCard('tab-1')
    const ackWrites = countWritesTo('acknowledgedAgentsByPaneKey')

    try {
      // Any unrelated publication re-runs the scan; a scan with nothing left to do must not write.
      useAppStore.setState({ agentStatusEpoch: 2 })
      useAppStore.setState({ agentStatusEpoch: 3 })
    } finally {
      ackWrites.stop()
    }

    expect(ackWrites.count()).toBe(0)
  })

  it('clears the clicked card in every shared map, and leaves the other card alone', () => {
    render(<GridWithAutoAck />)
    clickCard('tab-1')

    const state = useAppStore.getState()
    // Activity + the sidebar's bold agent row.
    expect(state.acknowledgedAgentsByPaneKey[PANE_A]).toBeDefined()
    expect(state.acknowledgedAgentsByPaneKey[PANE_C]).toBeUndefined()
    // The tab bar's bell and the grid's own.
    expect(state.unreadAgentCompletionPanes[PANE_A]).toBeUndefined()
    expect(state.unreadAgentCompletionPanes[PANE_C]).toBe(true)
    expect(state.unreadTerminalTabs['tab-1']).toBeUndefined()
    expect(state.unreadTerminalTabs['tab-2']).toBe(true)
    // tab-1 keeps its bell, and rightly: unread is a property of the TAB, and its hidden
    // sibling pane is still unread. The neighbouring card is untouched either way.
    expect(cardAttentionBadge('tab-1')).toBe('unread')
    expect(cardAttentionBadge('tab-2')).toBe('unread')
  })

  it('puts a plain card\u2019s bell out on the click, glyph and all', () => {
    render(<GridWithAutoAck />)
    expect(cardAttentionBadge('tab-2')).toBe('unread')

    clickCard('tab-2')

    // tab-2 is a single pane, so nothing is left holding its attention: the ladder drops
    // from `unread` back to the finished turn underneath it.
    expect(cardAttentionBadge('tab-2')).toBe('done')
    expect(
      document
        .querySelector('[data-tab-id="tab-2"] [data-attention-badge] svg')
        ?.getAttribute('class')
    ).not.toContain('text-amber-500')
  })

  /** A split tab shows one leaf. Acking its siblings would silence turns nobody saw. */
  it('leaves the hidden sibling pane of a split tab unread', () => {
    render(<GridWithAutoAck />)
    clickCard('tab-1')

    const state = useAppStore.getState()
    expect(state.acknowledgedAgentsByPaneKey[SIBLING_PANE]).toBeUndefined()
    expect(state.unreadAgentCompletionPanes[SIBLING_PANE]).toBe(true)
  })

  /**
   * The Dock badge rides worktree unread, which is coarse: it may only go out once nothing
   * else in the workspace is still waiting to be seen.
   */
  it('holds the workspace-level unread while anything else in it is still unread', () => {
    render(<GridWithAutoAck />)
    clickCard('tab-1')

    // The Dock badge rides this flag and it is workspace-coarse: tab-2 and tab-1's hidden
    // pane have not been seen, so clearing it here would hide two turns behind one click.
    expect(useAppStore.getState().worktreesByRepo['repo-1']![0]!.isUnread).toBe(true)
  })

  it('drops the workspace unread once the clicked card was the only thing holding it', () => {
    // A workspace with one plain card, which is what makes the coarse flag safe to clear.
    useAppStore.setState({
      tabsByWorktree: {
        [WT_ID]: [
          { id: 'tab-2', ptyId: 'pty-c', worktreeId: WT_ID, title: 'Other', createdAt: 2 }
        ] as TerminalTab[]
      },
      agentStatusByPaneKey: { [PANE_C]: doneEntryStampedAhead(PANE_C) },
      unreadAgentCompletionPanes: { [PANE_C]: true },
      unreadTerminalTabs: { 'tab-2': true }
    })
    render(<GridWithAutoAck />)

    clickCard('tab-2')

    expect(useAppStore.getState().worktreesByRepo['repo-1']![0]!.isUnread).toBe(false)
  })

  /**
   * The scan's ref-equality guard skips a publication that moved nothing it tracks. Selecting
   * another card moves ONLY `activeSessionGridTabId`, so with the first card's ack already
   * settled the guard has to know about it — otherwise the second card is never acked and
   * the failure is silent, on a surface the grid does not even own.
   */
  it('acks the next card too when the selection moves from one to another', () => {
    render(<GridWithAutoAck />)
    clickCard('tab-1')
    expect(useAppStore.getState().acknowledgedAgentsByPaneKey[PANE_A]).toBeDefined()

    clickCard('tab-2')

    expect(useAppStore.getState().acknowledgedAgentsByPaneKey[PANE_C]).toBeDefined()
    expect(useAppStore.getState().unreadAgentCompletionPanes[PANE_C]).toBeUndefined()
    expect(useAppStore.getState().unreadTerminalTabs['tab-2']).toBeUndefined()
  })

  /**
   * A tab-level bell with no agent row behind it: a parked pane that produced bytes. The
   * terminal view clears it when the pane mounts; a grid card mounts a preview, not a pane,
   * so the ack has to clear it or the bell survives the click that lit nothing else.
   */
  it('clears a tab-level bell that has no agent pane to ack', () => {
    useAppStore.setState({
      agentStatusByPaneKey: {},
      unreadAgentCompletionPanes: {},
      unreadTerminalTabs: { 'tab-1': true, 'tab-2': true }
    })
    render(<GridWithAutoAck />)
    expect(cardAttentionBadge('tab-1')).toBe('unread')

    clickCard('tab-1')

    expect(useAppStore.getState().unreadTerminalTabs['tab-1']).toBeUndefined()
    expect(useAppStore.getState().unreadTerminalTabs['tab-2']).toBe(true)
    expect(cardAttentionBadge('tab-1')).toBe('none')
  })

  /**
   * The bell that arrives AFTER the card is already selected. A parked pane's BEL writes only
   * `markTerminalTabUnread` — no agent status, no completion pane — so if the scan's guard does
   * not watch that map, nothing it tracks has moved and it takes the early exit. The card you
   * are looking at then wears a bell that no click can put out, and the Dock keeps the
   * workspace unread until you select something else and come back.
   */
  it('clears a bell that lands on the card already selected', () => {
    render(<GridWithAutoAck />)
    // tab-2 is the single-pane card, so nothing else of its own holds attention afterwards.
    clickCard('tab-2')
    expect(useAppStore.getState().unreadTerminalTabs['tab-2']).toBeUndefined()
    expect(cardAttentionBadge('tab-2')).toBe('done')

    // A parked pane rings while its card is the selected one.
    act(() => {
      useAppStore.getState().markTerminalTabUnread('tab-2')
    })

    expect(useAppStore.getState().unreadTerminalTabs['tab-2']).toBeUndefined()
    expect(cardAttentionBadge('tab-2')).toBe('done')
  })

  /** The same bell, put out by clicking the card again rather than by the scan noticing. */
  it('lets a second click on the same card put a later bell out', () => {
    render(<GridWithAutoAck />)
    clickCard('tab-1')
    // Mark it while the scan cannot see it, so only the click can clear it.
    useAppStore.setState({ unreadTerminalTabs: { 'tab-1': true, 'tab-2': true } })

    clickCard('tab-1')

    expect(useAppStore.getState().unreadTerminalTabs['tab-1']).toBeUndefined()
    expect(useAppStore.getState().unreadTerminalTabs['tab-2']).toBe(true)
  })

  /**
   * Tab moves through every header button of every card. Selecting acknowledges in five
   * surfaces, so if focus on any descendant selected the card, one Tab sweep over a grid of
   * nine would silence nine turns — the exact "nine at once" failure the viewport-ack variant
   * was rejected for, reached by keyboard instead of by scrolling.
   *
   * The viewport half is the control: without it a broken focus path would make the negative
   * assertion pass for the wrong reason.
   */
  it('does not select — or acknowledge — a card merely tabbed through', () => {
    render(<GridWithAutoAck />)
    const hideButton = document.querySelector<HTMLElement>(
      '[data-tab-id="tab-2"] [data-testid="session-grid-card-hide"]'
    )
    expect(hideButton).not.toBeNull()

    act(() => {
      fireEvent.focus(hideButton!)
      fireEvent.focusIn(hideButton!)
    })

    expect(useAppStore.getState().activeSessionGridTabId).toBeNull()
    expect(useAppStore.getState().unreadTerminalTabs['tab-2']).toBe(true)

    // Control: focus landing in the card's own terminal IS attending it.
    const viewport = document.querySelector<HTMLElement>('[data-tab-id="tab-2"] [data-pty-id]')
    expect(viewport).not.toBeNull()
    act(() => {
      fireEvent.focus(viewport!)
      fireEvent.focusIn(viewport!)
    })

    expect(useAppStore.getState().activeSessionGridTabId).toBe('tab-2')
    expect(useAppStore.getState().unreadTerminalTabs['tab-2']).toBeUndefined()
  })

  it('acks nothing at all until a card is actually clicked', () => {
    render(<GridWithAutoAck />)

    const state = useAppStore.getState()
    expect(state.acknowledgedAgentsByPaneKey).toEqual({})
    expect(state.unreadTerminalTabs).toEqual({ 'tab-1': true, 'tab-2': true })
  })
})

function cardAttentionBadge(tabId: string): string | null {
  return (
    document
      .querySelector(`[data-tab-id="${tabId}"] [data-attention-badge]`)
      ?.getAttribute('data-attention-badge') ?? null
  )
}
