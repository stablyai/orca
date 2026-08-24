// @vitest-environment happy-dom

// The editor boundary is where the 9-hour field incident happened: an app
// update swaps assets under a live renderer, Retry re-fetches dead chunks
// forever, and without a "Restart Orca" affordance the user has no recovery.
// These tests pin that the shared stale-chunk recovery row renders here too —
// and only for stale chunks on relaunch-capable hosts.

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LazyChunkLoadError } from '@/lib/lazy-with-retry'
import { RELAUNCH_SETTLE_GRACE_MS } from '@/components/error-boundaries/StaleChunkRecoveryActions'
import {
  clearLazyChunkBreadcrumbDedupeForTest,
  RichMarkdownErrorBoundary
} from './RichMarkdownErrorBoundary'

const reportCrashMock = vi.hoisted(() => vi.fn())
const recordBreadcrumbMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/react-error-boundary-reporting', () => ({
  reportReactErrorBoundaryCrash: reportCrashMock
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: recordBreadcrumbMock
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function ThrowingChild({ error }: { error: Error }): ReactElement {
  throw error
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
      button.textContent?.includes(text)
    ) ?? null
  )
}

describe('RichMarkdownErrorBoundary Restart Orca row', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    reportCrashMock.mockReset()
    recordBreadcrumbMock.mockReset()
    clearLazyChunkBreadcrumbDedupeForTest()
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
    consoleError.mockRestore()
    vi.useRealTimers()
  })

  function renderBoundaryWith(error: Error, fileId = 'file-1'): void {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(
        <RichMarkdownErrorBoundary fileId={fileId}>
          <ThrowingChild error={error} />
        </RichMarkdownErrorBoundary>
      )
    })
  }

  it('renders the shared recovery row for a stale chunk when the host can relaunch', () => {
    const relaunch = vi.fn<() => Promise<void>>().mockReturnValue(new Promise(() => undefined))
    ;(window as unknown as { api: unknown }).api = { app: { relaunch } }

    renderBoundaryWith(new LazyChunkLoadError(new SyntaxError("Unexpected token '}'")))

    expect(container!.textContent).toContain('This part of Orca could not load.')
    const restart = findButtonByText(container!, 'Restart Orca')
    expect(restart).not.toBeNull()

    // Restart leads as primary; Retry is the lower-emphasis sibling.
    const buttons = Array.from(container!.querySelectorAll<HTMLButtonElement>('button'))
    expect(buttons[0]).toBe(restart)
    expect(restart?.dataset.variant).toBe('default')
    expect(findButtonByText(container!, 'Retry')?.dataset.variant).toBe('secondary')

    act(() => restart?.click())
    expect(relaunch).toHaveBeenCalledTimes(1)
    expect(restart?.disabled).toBe(true)
    expect(findButtonByText(container!, 'Retry')?.disabled).toBe(true)
  })

  it('keeps the plain editor fallback for ordinary errors even with the bridge', () => {
    ;(window as unknown as { api: unknown }).api = { app: { relaunch: vi.fn() } }

    renderBoundaryWith(new Error('ordinary render failure'))

    expect(findButtonByText(container!, 'Restart Orca')).toBeNull()
    expect(container!.textContent).toContain('rich markdown editor hit an unexpected error')
    expect(findButtonByText(container!, 'Retry')).not.toBeNull()
  })

  it('keeps the plain editor fallback for a stale chunk on hosts without the bridge', () => {
    delete (window as unknown as { api?: unknown }).api

    renderBoundaryWith(new LazyChunkLoadError(new SyntaxError("Unexpected token '}'")))

    expect(findButtonByText(container!, 'Restart Orca')).toBeNull()
    expect(container!.textContent).toContain('rich markdown editor hit an unexpected error')
    expect(findButtonByText(container!, 'Retry')).not.toBeNull()
  })

  it('does not leak the stalled-restart notice into a later error after a fileId re-key', async () => {
    vi.useFakeTimers()
    const relaunch = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    ;(window as unknown as { api: unknown }).api = { app: { relaunch } }

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const renderWith = (fileId: string, error: Error): void => {
      act(() => {
        root?.render(
          <RichMarkdownErrorBoundary fileId={fileId}>
            <ThrowingChild error={error} />
          </RichMarkdownErrorBoundary>
        )
      })
    }

    renderWith('file-a', new LazyChunkLoadError(new SyntaxError("Unexpected token '}'")))
    act(() => findButtonByText(container!, 'Restart Orca')?.click())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RELAUNCH_SETTLE_GRACE_MS + 1)
    })
    expect(container!.textContent).toContain("Restarting didn't complete.")

    // The re-key abandons that fallback; a fresh stale error must start clean.
    renderWith('file-b', new LazyChunkLoadError(new SyntaxError("Unexpected token ']'")))
    expect(findButtonByText(container!, 'Restart Orca')).not.toBeNull()
    expect(container!.textContent).not.toContain("Restarting didn't complete.")
  })
})
