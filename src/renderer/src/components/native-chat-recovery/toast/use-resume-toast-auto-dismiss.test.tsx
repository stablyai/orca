// @vitest-environment happy-dom
import { useCallback } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Toaster, toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useResumeToastAutoDismiss } from './use-resume-toast-auto-dismiss'

const TOAST_ID = 'resume-report'

function Report(): React.JSX.Element {
  const close = useCallback(() => toast.dismiss(TOAST_ID), [])
  const { onDetailsOpened, interactionHandlers } = useResumeToastAutoDismiss(true, close)
  return (
    <div data-testid="report" {...interactionHandlers}>
      Resumed 20 chats after the restart.
      <button type="button" onClick={onDetailsOpened}>
        Details
      </button>
    </div>
  )
}

function showReport(): void {
  // Matches the host: the report owns its timer, so the toaster never expires it.
  toast.custom(() => <Report />, { id: TOAST_ID, duration: Infinity, unstyled: true })
}

function setDocumentHidden(hidden: boolean): void {
  if (hidden) {
    Object.defineProperties(document, {
      hidden: { configurable: true, value: true },
      visibilityState: { configurable: true, value: 'hidden' }
    })
  } else {
    Reflect.deleteProperty(document, 'hidden')
    Reflect.deleteProperty(document, 'visibilityState')
  }
  document.dispatchEvent(new Event('visibilitychange'))
}

// Step the clock so effects scheduled by a dismissal (the toaster's unmount delay) also run.
async function advance(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(100, ms - elapsed))
    })
  }
}

const reportShown = (): boolean => screen.queryByTestId('report') !== null

describe('useResumeToastAutoDismiss', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    render(<Toaster />)
  })
  afterEach(() => {
    act(() => {
      toast.dismiss()
    })
    setDocumentHidden(false)
    cleanup()
    vi.useRealTimers()
  })

  it('leaves five seconds after it is shown', async () => {
    act(showReport)
    await advance(100)
    expect(reportShown()).toBe(true)
    await advance(4800)
    expect(reportShown()).toBe(true)
    await advance(1000)
    expect(reportShown()).toBe(false)
  })

  it('waits while the window is hidden, then leaves five seconds after focus returns', async () => {
    act(showReport)
    await advance(100)
    act(() => setDocumentHidden(true))
    await advance(8000)
    expect(reportShown()).toBe(true)
    // macOS can refocus the window while Chromium still reports the document hidden.
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await advance(4500)
    expect(reportShown()).toBe(true)
    await advance(1500)
    expect(reportShown()).toBe(false)
  })

  it('gets a fresh five seconds each time focus returns to the window', async () => {
    act(showReport)
    await advance(100)
    await advance(4000)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await advance(4500)
    expect(reportShown()).toBe(true)
    await advance(1500)
    expect(reportShown()).toBe(false)
  })

  it('stays while hovered and gets a fresh five seconds after the pointer leaves', async () => {
    act(showReport)
    await advance(100)
    fireEvent.pointerEnter(screen.getByTestId('report'))
    await advance(8000)
    expect(reportShown()).toBe(true)
    fireEvent.pointerLeave(screen.getByTestId('report'))
    await advance(4500)
    expect(reportShown()).toBe(true)
    await advance(1500)
    expect(reportShown()).toBe(false)
  })

  it('stays once Details is opened', async () => {
    act(showReport)
    await advance(100)
    fireEvent.click(screen.getByText('Details'))
    await advance(20000)
    expect(reportShown()).toBe(true)
  })
})
