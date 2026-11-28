// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster, toast } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { LocalBaseRefRefreshResult } from '../../../../../../shared/worktree/base-refs/base-ref-drift-types'
import { showLocalBaseRefRefreshToast } from './local-base-ref-refresh-toast'

type Launch = { onSettled: (started: boolean) => void }
const launches = vi.hoisted((): Launch[] => [])
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: () => true
}))
vi.mock('@/components/terminal/tab-lifecycle/terminal-tab-create', () => ({
  createNewTerminalTab: (_worktreeId: string, _tab: unknown, options: Launch) =>
    launches.push(options)
}))

const REFRESH: LocalBaseRefRefreshResult = {
  status: 'skipped_not_fast_forward',
  baseRef: 'origin/main',
  localBranch: 'main'
}
const SHALLOW: LocalBaseRefRefreshResult = { ...REFRESH, shallowHistory: true }
const REFRESH_TITLE = 'main not updated'
const SHALLOW_TITLE = 'Local main not updated: shallow clone'

function show(result: LocalBaseRefRefreshResult): void {
  showLocalBaseRefRefreshToast(
    result,
    { id: 'wt', repoId: 'repo', displayName: 'feature', branch: 'feature', path: '/w' },
    { updateSettings: async () => {} }
  )
}

function settle(): void {
  // Sonner applies dismissals a frame later and removes toasts after an exit timer.
  for (let i = 0; i < 3; i++) {
    act(() => vi.advanceTimersByTime(1000))
  }
}

function shownTitles(): string[] {
  return [REFRESH_TITLE, SHALLOW_TITLE].flatMap((title) =>
    screen.queryAllByText(title).map(() => title)
  )
}

let resizeCallbacks: (() => void)[] = []

beforeEach(() => {
  vi.useFakeTimers()
  resizeCallbacks = []
  launches.length = 0
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resizeCallbacks.push(callback)
      }
      observe(): void {}
      disconnect(): void {}
    }
  )
  render(
    <TooltipProvider>
      <Toaster closeButton />
    </TooltipProvider>
  )
})
afterEach(() => {
  // Why settle, not runAllTimers: sonner's removal needs React effects between its frame and timer.
  // Why: the in-flight unshallow guard is module state, so finish every launch.
  act(() => launches.forEach((launch) => launch.onSettled(true)))
  act(() => toast.dismiss())
  settle()
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('local base ref refresh toast', () => {
  // First: module state is shared across tests, and this race needs a target with no history.
  it('keeps the latest result when the wall clock jumps past pending frames', () => {
    act(() => {
      show(REFRESH)
      show(SHALLOW)
      vi.setSystemTime(Date.now() + 2000)
      show(REFRESH)
    })
    settle()
    expect(shownTitles()).toEqual([REFRESH_TITLE])
  })

  it.each([
    [[REFRESH, SHALLOW, REFRESH], REFRESH_TITLE],
    [[SHALLOW, REFRESH, SHALLOW], SHALLOW_TITLE],
    [[REFRESH, REFRESH], REFRESH_TITLE]
  ])('keeps exactly the latest variant after rapid results', (results, expected) => {
    act(() => results.forEach(show))
    settle()
    expect(shownTitles()).toEqual([expected])
  })

  it.each([REFRESH, SHALLOW])(
    'shows a result that arrives while the closed toast is still leaving',
    (result) => {
      act(() => show(result))
      act(() => vi.advanceTimersByTime(0))
      act(() => {
        fireEvent.click(screen.getAllByRole('button', { name: /^Close/ })[0])
        show(result)
      })
      settle()
      expect(shownTitles()).toHaveLength(1)
    }
  )

  it('shows a result that arrives while a swiped-away toast is still leaving', () => {
    act(() => show(SHALLOW))
    act(() => vi.advanceTimersByTime(0))
    const toastElement = document.querySelector<HTMLElement>('[data-sonner-toast]')!
    toastElement.setPointerCapture = () => {}
    // Two moves: sonner locks the swipe direction on the first and applies it on the next render.
    act(() => fireEvent.pointerDown(toastElement, { clientX: 0, clientY: 0, pointerId: 1 }))
    act(() => fireEvent.pointerMove(toastElement, { clientX: 0, clientY: 100, pointerId: 1 }))
    act(() => fireEvent.pointerMove(toastElement, { clientX: 0, clientY: 200, pointerId: 1 }))
    act(() => fireEvent.pointerUp(toastElement, { clientX: 0, clientY: 200, pointerId: 1 }))
    expect(toastElement.getAttribute('data-removed')).toBe('true')
    act(() => show(SHALLOW))
    settle()
    expect(shownTitles()).toEqual([SHALLOW_TITLE])
  })

  it('shows the latest result that arrives while a closed toast is leaving, despite late timers', () => {
    act(() => show(SHALLOW))
    act(() => vi.advanceTimersByTime(0))
    act(() => fireEvent.click(screen.getAllByRole('button', { name: /^Close/ })[0]))
    // Late timers and frames: the clock jumps while sonner has not removed the closed toast yet.
    act(() => {
      vi.setSystemTime(Date.now() + 10_000)
      show(SHALLOW)
      show(REFRESH)
    })
    settle()
    expect(shownTitles()).toEqual([REFRESH_TITLE])
  })

  it('keeps one history entry per target across repeated results and close cycles', () => {
    const ownEntries = (): number =>
      toast
        .getHistory()
        .filter((entry) => String(entry.id).startsWith('local-base-ref-refresh-failed:')).length
    for (let i = 0; i < 50; i++) {
      act(() => show(i % 2 ? SHALLOW : REFRESH))
    }
    settle()
    expect(ownEntries()).toBe(1)
    for (let i = 0; i < 20; i++) {
      act(() => fireEvent.click(screen.getAllByRole('button', { name: /^Close/ })[0]))
      act(() => show(i % 2 ? REFRESH : SHALLOW))
      settle()
    }
    expect(ownEntries()).toBe(1)
    expect(shownTitles()).toEqual([REFRESH_TITLE])
    act(() => fireEvent.click(screen.getAllByRole('button', { name: /^Close/ })[0]))
    settle()
    expect(ownEntries()).toBe(0)
    expect(shownTitles()).toEqual([])
  })

  it('re-renders the latest result when an older card reports a resize late', () => {
    act(() => show(REFRESH))
    act(() => vi.advanceTimersByTime(0))
    const olderCardResize = resizeCallbacks.at(-1)!
    act(() => show(SHALLOW))
    act(() => vi.advanceTimersByTime(0))
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120)
    act(() => olderCardResize())
    settle()
    expect(shownTitles()).toEqual([SHALLOW_TITLE])
  })

  async function clickUnshallow(): Promise<void> {
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Unshallow' })))
    await act(() => vi.dynamicImportSettled())
  }

  it('runs one unshallow per target, even from a re-shown toast', async () => {
    act(() => show(SHALLOW))
    act(() => vi.advanceTimersByTime(0))
    await clickUnshallow()
    act(() => fireEvent.click(screen.getAllByRole('button', { name: /^Close/ })[0]))
    act(() => show(SHALLOW))
    settle()
    await clickUnshallow()
    expect(launches).toHaveLength(1)
  })

  it('keeps a newer result shown in place when an earlier unshallow finishes', async () => {
    act(() => show(SHALLOW))
    act(() => vi.advanceTimersByTime(0))
    await clickUnshallow()
    act(() => show(REFRESH))
    act(() => launches[0].onSettled(true))
    settle()
    expect(shownTitles()).toEqual([REFRESH_TITLE])
  })

  it('shows a result that arrives while the closed card is still leaving', () => {
    act(() => show(REFRESH))
    act(() => vi.advanceTimersByTime(0))
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
      show(REFRESH)
    })
    settle()
    expect(shownTitles()).toEqual([REFRESH_TITLE])
  })
})
