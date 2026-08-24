// @vitest-environment happy-dom

// The "Restart Orca" escape hatch on contained lazy-chunk fallbacks: a broken
// document should not be the one recovering itself, so the main-driven restart
// is the primary action and the in-place Retry its lower-emphasis sibling. It
// must only appear when the failure is a stale chunk AND the host can relaunch,
// a refused pre-relaunch checkpoint must re-enable it, and a relaunch that
// leaves this document alive (swallowed in-place reload on the browser
// fallback host, hung invoke) must give the buttons back after a grace.

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LazyChunkLoadError } from '@/lib/lazy-with-retry'
import {
  isIntentionalAppRestartInProgress,
  registerUpdaterBeforeUnloadBypass
} from '@/lib/updater-beforeunload'
import { RecoverableRenderErrorBoundary } from './RecoverableRenderErrorBoundary'
import { RELAUNCH_SETTLE_GRACE_MS } from './StaleChunkRecoveryActions'
import { ORCA_APP_RESTART_STARTED_EVENT } from '../../../../shared/updater-renderer-events'

const reportCrashMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/react-error-boundary-reporting', () => ({
  reportReactErrorBoundaryCrash: reportCrashMock
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function ThrowingChild({ error }: { error: Error }): ReactElement {
  throw error
}

function findRestartButton(container: HTMLElement): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>('[role="alert"] button')).find(
      (button) => button.textContent?.includes('Restart Orca')
    ) ?? null
  )
}

function findRetryButton(container: HTMLElement): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>('[role="alert"] button')).find(
      (button) => button.textContent?.includes('Retry')
    ) ?? null
  )
}

describe('RecoverableRenderErrorBoundary Restart Orca button', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null
  let consoleError: ReturnType<typeof vi.spyOn>
  let unregisterRestartBypass = (): void => undefined

  beforeEach(() => {
    reportCrashMock.mockReset()
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
    delete (window as unknown as { api?: unknown }).api
    unregisterRestartBypass()
    unregisterRestartBypass = () => undefined
    consoleError.mockRestore()
    vi.useRealTimers()
  })

  function renderBoundaryWith(error: Error): void {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(
        <RecoverableRenderErrorBoundary boundaryId="right-sidebar" surface="right-sidebar">
          <ThrowingChild error={error} />
        </RecoverableRenderErrorBoundary>
      )
    })
  }

  it('offers Restart Orca as the primary action for a contained chunk failure when the host can relaunch', () => {
    const relaunch = vi.fn<() => Promise<void>>().mockReturnValue(new Promise(() => undefined))
    ;(window as unknown as { api: unknown }).api = { app: { relaunch } }

    renderBoundaryWith(new LazyChunkLoadError(new SyntaxError("Unexpected token '}'")))

    const restart = findRestartButton(container!)
    expect(restart).not.toBeNull()
    expect(container!.textContent).toContain('This part of Orca could not load.')

    // The main-driven restart leads; the in-place Retry is its lower-emphasis sibling.
    const buttons = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('[role="alert"] button')
    )
    expect(buttons[0]).toBe(restart)
    expect(restart?.dataset.variant).toBe('default')
    const retry = findRetryButton(container!)
    expect(retry?.dataset.variant).toBe('secondary')

    act(() => restart?.click())
    expect(relaunch).toHaveBeenCalledTimes(1)
    // Both stay disabled while the main-driven relaunch tears the window down —
    // a Retry that swaps the surface out mid-checkpoint helps nobody.
    expect(restart?.disabled).toBe(true)
    expect(findRetryButton(container!)?.disabled).toBe(true)
  })

  it('sends one relaunch when Restart Orca is double-clicked before the disabled state commits', () => {
    const relaunch = vi.fn<() => Promise<void>>().mockReturnValue(new Promise(() => undefined))
    ;(window as unknown as { api: unknown }).api = { app: { relaunch } }

    renderBoundaryWith(new LazyChunkLoadError(new SyntaxError("Unexpected token '}'")))

    const restart = findRestartButton(container!)
    act(() => {
      // Raw dispatch models the second click of a double-click landing before
      // React commits the disabled attribute; a doubled app.relaunch() would
      // spawn two replacement instances.
      const click = (): void => {
        restart?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      }
      click()
      click()
    })
    expect(relaunch).toHaveBeenCalledTimes(1)
  })

  it('keeps the buttons locked past the grace while the relaunch invoke is still pending', async () => {
    vi.useFakeTimers()
    // Electron shape mid-flight: a slow pre-relaunch checkpoint legitimately
    // keeps the invoke pending; re-arming the button here could double
    // app.relaunch() into two replacement instances.
    const relaunch = vi.fn<() => Promise<void>>().mockReturnValue(new Promise(() => undefined))
    ;(window as unknown as { api: unknown }).api = { app: { relaunch } }

    renderBoundaryWith(new LazyChunkLoadError(new SyntaxError("Unexpected token '}'")))

    act(() => findRestartButton(container!)?.click())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RELAUNCH_SETTLE_GRACE_MS * 3)
    })
    expect(findRestartButton(container!)?.disabled).toBe(true)
    expect(container!.textContent).not.toContain("Restarting didn't complete.")
  })

  it('gives the buttons back with a notice when the document survives a resolved relaunch', async () => {
    vi.useFakeTimers()
    unregisterRestartBypass = registerUpdaterBeforeUnloadBypass()
    // Browser-fallback host shape: relaunch is an in-place reload that resolves
    // immediately; a broken document can swallow the navigation entirely.
    const relaunch = vi.fn<() => Promise<void>>().mockImplementation(() => {
      window.dispatchEvent(new Event(ORCA_APP_RESTART_STARTED_EVENT))
      return Promise.resolve()
    })
    ;(window as unknown as { api: unknown }).api = { app: { relaunch } }

    renderBoundaryWith(new LazyChunkLoadError(new SyntaxError("Unexpected token '}'")))

    const restart = findRestartButton(container!)
    act(() => restart?.click())
    expect(restart?.disabled).toBe(true)
    expect(isIntentionalAppRestartInProgress()).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RELAUNCH_SETTLE_GRACE_MS + 1)
    })
    expect(findRestartButton(container!)?.disabled).toBe(false)
    expect(findRetryButton(container!)?.disabled).toBe(false)
    expect(container!.textContent).toContain("Restarting didn't complete.")
    expect(container!.querySelector('[role="status"]')).not.toBeNull()
    expect(isIntentionalAppRestartInProgress()).toBe(false)

    // The stall cleared the guard, so a second attempt is a fresh request.
    act(() => findRestartButton(container!)?.click())
    expect(relaunch).toHaveBeenCalledTimes(2)
    expect(container!.textContent).not.toContain("Restarting didn't complete.")
    expect(isIntentionalAppRestartInProgress()).toBe(true)
  })

  it('does not leak the stalled-restart notice into a later error after a resetKey reset', async () => {
    vi.useFakeTimers()
    const relaunch = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    ;(window as unknown as { api: unknown }).api = { app: { relaunch } }

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const renderWith = (resetKey: string, error: Error): void => {
      act(() => {
        root?.render(
          <RecoverableRenderErrorBoundary
            boundaryId="right-sidebar"
            surface="right-sidebar"
            resetKey={resetKey}
          >
            <ThrowingChild error={error} />
          </RecoverableRenderErrorBoundary>
        )
      })
    }

    renderWith('doc-a', new LazyChunkLoadError(new SyntaxError("Unexpected token '}'")))
    act(() => findRestartButton(container!)?.click())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RELAUNCH_SETTLE_GRACE_MS + 1)
    })
    expect(container!.textContent).toContain("Restarting didn't complete.")

    // A reset abandons that fallback; the next, unrelated error must not carry
    // a stalled-restart notice whose "Try again" has no Restart button.
    renderWith('doc-b', new Error('ordinary render failure'))
    expect(container!.querySelector('[role="alert"]')).not.toBeNull()
    expect(findRestartButton(container!)).toBeNull()
    expect(container!.textContent).not.toContain("Restarting didn't complete.")

    // A later stale error renders the row again — remounted fresh, not with the
    // doc-a row's stalled/disabled state (catching an error rebuilds the subtree).
    renderWith('doc-c', new LazyChunkLoadError(new SyntaxError("Unexpected token ']'")))
    expect(findRestartButton(container!)?.disabled).toBe(false)
    expect(container!.textContent).not.toContain("Restarting didn't complete.")
  })

  it('drops the settle timer when the boundary unmounts around the relaunch', async () => {
    vi.useFakeTimers()
    let resolveRelaunch: () => void = () => undefined
    const relaunch = vi.fn<() => Promise<void>>().mockReturnValue(
      new Promise((resolve) => {
        resolveRelaunch = resolve
      })
    )
    ;(window as unknown as { api: unknown }).api = { app: { relaunch } }

    // Unmount while the invoke is pending: the resolve must not schedule a timer
    // into a torn-down instance.
    renderBoundaryWith(new LazyChunkLoadError(new SyntaxError("Unexpected token '}'")))
    act(() => findRestartButton(container!)?.click())
    act(() => root?.unmount())
    root = null
    await act(async () => {
      resolveRelaunch()
      await Promise.resolve()
    })
    expect(vi.getTimerCount()).toBe(0)

    // Unmount after the invoke resolved: the already-armed timer must be cleared.
    container?.remove()
    renderBoundaryWith(new LazyChunkLoadError(new SyntaxError("Unexpected token '}'")))
    act(() => findRestartButton(container!)?.click())
    await act(async () => {
      await Promise.resolve()
    })
    expect(vi.getTimerCount()).toBe(1)
    act(() => root?.unmount())
    root = null
    expect(vi.getTimerCount()).toBe(0)
  })

  it('re-enables the button when the pre-relaunch checkpoint refuses', async () => {
    let rejectRelaunch: (error: Error) => void = () => undefined
    const relaunch = vi.fn<() => Promise<void>>().mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectRelaunch = reject
      })
    )
    ;(window as unknown as { api: unknown }).api = { app: { relaunch } }

    renderBoundaryWith(new LazyChunkLoadError(new SyntaxError("Unexpected token '}'")))

    const restart = findRestartButton(container!)
    act(() => restart?.click())
    expect(restart?.disabled).toBe(true)

    await act(async () => {
      rejectRelaunch(new Error('Renderer shutdown checkpoint was not completed.'))
      await Promise.resolve()
    })
    expect(findRestartButton(container!)?.disabled).toBe(false)
  })

  it('hides Restart Orca for ordinary render errors and hosts without relaunch', () => {
    ;(window as unknown as { api: unknown }).api = { app: { relaunch: vi.fn() } }
    renderBoundaryWith(new Error('ordinary render failure'))
    expect(findRestartButton(container!)).toBeNull()
    expect(container!.textContent).toContain('This part of Orca hit an error.')
    // Non-stale errors keep the standalone outline Retry, exactly as before.
    expect(findRetryButton(container!)?.dataset.variant).toBe('outline')
    act(() => root?.unmount())
    root = null
    container?.remove()

    // Degraded/partial preload shape with no app bridge. (The real browser
    // fallback DOES expose app.relaunch as an in-place reload — that host is
    // covered by the settle-grace tests above, not by hiding the button.)
    delete (window as unknown as { api?: unknown }).api
    renderBoundaryWith(new LazyChunkLoadError(new SyntaxError("Unexpected token '}'")))
    expect(container!.querySelector('[role="alert"]')).not.toBeNull()
    expect(findRestartButton(container!)).toBeNull()
  })
})
