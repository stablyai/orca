// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactVirtual from '@tanstack/react-virtual'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useAppStore } from '@/store'
import SessionsGridPage from './SessionsGridPage'
import { livePtyIdsFor } from './session-grid-test-live-ptys'
import { SESSION_GRID_SCROLL_CONTAINER_ID } from './use-session-grid-scroll'
import { SESSION_GRID_ROW_GAP_PX } from './session-grid-slot-layout'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
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
vi.mock('../dashboard-popout/AgentTerminalPreview', () => ({
  AgentTerminalPreview: ({ ptyId }: { ptyId: string }) => <div data-pty-id={ptyId} />
}))

const CONTAINER_HEIGHT = 600
// 600 - 2*12 padding - 1*12 gap, halved: what a 2-row viewport leaves per row.
const ROW_STEP = 282 + SESSION_GRID_ROW_GAP_PX

const initialState = useAppStore.getInitialState()
let restoreClientHeight: (() => void) | null = null

/** happy-dom lays nothing out, so the scroll hook would measure a zero-height viewport. */
function stubLayoutMeasurement(): void {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return (this as HTMLElement).id === SESSION_GRID_SCROLL_CONTAINER_ID ? CONTAINER_HEIGHT : 0
    }
  })
  const originalScrollTo = HTMLElement.prototype.scrollTo
  HTMLElement.prototype.scrollTo = function scrollTo(options?: ScrollToOptions | number): void {
    const top = typeof options === 'number' ? options : (options?.top ?? 0)
    Object.defineProperty(this, 'scrollTop', { value: top, configurable: true, writable: true })
  }
  restoreClientHeight = () => {
    if (original) {
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', original)
    }
    HTMLElement.prototype.scrollTo = originalScrollTo
  }
}

function scrollContainer(): HTMLElement {
  const el = document.getElementById(SESSION_GRID_SCROLL_CONTAINER_ID)
  expect(el).not.toBeNull()
  return el!
}

/** 12 cards in a 2x2 grid: rows 0-1 on screen, index 8 sits on row 4. */
function seed(unreadTabIndexes: number[], mode: 'row' | 'free' = 'row'): void {
  const tabsByWorktree: Record<string, TerminalTab[]> = {
    'wt-1': Array.from({ length: 12 }, (_, i) => ({
      id: `tab-${i}`,
      ptyId: `pty-${i}`,
      worktreeId: 'wt-1',
      title: `Session ${i}`,
      createdAt: i
    })) as TerminalTab[]
  }
  useAppStore.setState({
    activeView: 'sessions',
    activeSessionGridTabId: null,
    sessionsGridPreset: '2x2',
    sessionsGridScrollMode: mode,
    sessionsGridZoom: 1,
    // No trailing empty row, so the row count is exactly the cards'.
    sessionsGridShowEmpty: false,
    sessionsGridFilter: 'all',
    sessionsGridStateFilter: 'all',
    sessionsGridTabOrder: [],
    sessionsGridHiddenTabIds: [],
    repos: [{ id: 'repo-1', displayName: 'sytio', path: '/code/sytio' } as unknown as Repo],
    worktreesByRepo: {
      'repo-1': [{ id: 'wt-1', displayName: 'sytio', branch: 'main' } as unknown as Worktree]
    },
    tabsByWorktree,
    ptyIdsByTabId: livePtyIdsFor(tabsByWorktree),
    terminalLayoutsByTabId: {},
    unreadTerminalTabs: Object.fromEntries(
      unreadTabIndexes.map((i) => [`tab-${i}`, true as const])
    ),
    unreadAgentCompletionPanes: {}
  })
}

function pill(direction: 'above' | 'below'): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-testid="session-grid-offscreen-attention"][data-direction="${direction}"]`
  )
}

describe('session-grid offscreen attention pill', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    stubLayoutMeasurement()
    useAppStore.setState(initialState, true)
  })

  afterEach(() => {
    cleanup()
    restoreClientHeight?.()
    restoreClientHeight = null
    vi.unstubAllGlobals()
    useAppStore.setState(initialState, true)
  })

  it('stays away while every card that needs you is on screen', () => {
    seed([1, 3])
    render(<SessionsGridPage />)

    expect(pill('above')).toBeNull()
    expect(pill('below')).toBeNull()
  })

  it('appears pointing down, counting the cards below the fold', () => {
    seed([8, 11])
    render(<SessionsGridPage />)

    const below = pill('below')
    expect(below).not.toBeNull()
    expect(below).toHaveTextContent('2')
    // "unseen", never the state chip's "Needs You" — the pill counts a wider set than that chip.
    expect(below).toHaveAttribute('aria-label', '2 unseen sessions below')
    expect(pill('above')).toBeNull()
  })

  it('takes you to the nearest one, and then points back the other way', () => {
    seed([8])
    render(<SessionsGridPage />)

    act(() => {
      fireEvent.click(pill('below')!)
    })

    // Index 8 is row 4; row mode scrolls that row to the top of the viewport.
    expect(scrollContainer().scrollTop).toBe(4 * ROW_STEP)
    expect(pill('below')).toBeNull()
    expect(pill('above')).toBeNull()
  })

  it('points back up at a card left behind', () => {
    seed([0])
    render(<SessionsGridPage />)
    expect(pill('above')).toBeNull()

    act(() => {
      // Drive the grid to the last row through the same navigator the toolbar uses.
      fireEvent.scroll(scrollContainer(), { target: { scrollTop: 4 * ROW_STEP } })
    })

    const above = pill('above')
    expect(above).not.toBeNull()
    expect(above).toHaveAttribute('aria-label', '1 unseen session above')
  })

  /**
   * Free mode scrolls continuously, so the top row is not page-aligned. Three rows down is
   * page 1.5, which the position rounds to 2 — claiming rows 4-5 are on screen. A card on row
   * 5 would then get no pill at all, and one on row 2 would get a pill it does not need.
   */
  it('reads a mid-page free-mode viewport exactly', () => {
    seed([0, 10], 'free')
    render(<SessionsGridPage />)

    act(() => {
      fireEvent.scroll(scrollContainer(), { target: { scrollTop: 3 * ROW_STEP } })
    })

    // Rows 3-4 are on screen: index 0 is row 0 above, index 10 is row 5 below.
    expect(pill('above')).toHaveAttribute('aria-label', '1 unseen session above')
    expect(pill('below')).toHaveAttribute('aria-label', '1 unseen session below')
  })

  it('says nothing for cards that are merely busy or already finished', () => {
    seed([])
    render(<SessionsGridPage />)

    // Every card is idle here, so nothing is asking for anything.
    expect(screen.queryAllByTestId('session-grid-offscreen-attention')).toHaveLength(0)
  })
})
