// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster, toast } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { LocalBaseRefRefreshResult } from '../../../../../../shared/worktree/base-refs/base-ref-drift-types'
import { showLocalBaseRefRefreshToast } from './local-base-ref-refresh-toast'

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

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal(
    'ResizeObserver',
    class {
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
  act(() => {
    toast.dismiss()
    vi.runAllTimers()
  })
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('local base ref refresh toast', () => {
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

  it('reuses ids once closed toasts are gone, so toast history stays bounded', () => {
    const before = toast.getHistory().length
    for (let i = 0; i < 50; i++) {
      act(() => show(i % 2 ? SHALLOW : REFRESH))
      act(() => vi.advanceTimersByTime(0))
      act(() => fireEvent.click(screen.getAllByRole('button', { name: /^Close/ })[0]))
      settle()
    }
    expect(toast.getHistory().length - before).toBeLessThanOrEqual(4)
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
