// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtifactPreview } from './ArtifactPreview'

function dispatchLoadFailure(
  webview: Element,
  failure: { errorCode: number; isMainFrame: boolean }
): void {
  const event = new Event('did-fail-load')
  Object.assign(event, {
    errorCode: failure.errorCode,
    errorDescription: 'failed',
    validatedURL: 'https://share.onorca.dev/a/report',
    isMainFrame: failure.isMainFrame
  })
  webview.dispatchEvent(event)
}

describe('ArtifactPreview', () => {
  beforeEach(() => {
    Object.assign(window, {
      api: {
        browser: { sessionResolvePartition: vi.fn().mockResolvedValue('persist:orca-default') }
      }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('ignores child-frame failures and aborted navigations', async () => {
    render(<ArtifactPreview shareUrl="https://share.onorca.dev/a/report" />)
    const webview = await waitFor(() => {
      const element = document.querySelector('webview')
      expect(element).not.toBeNull()
      return element as Element
    })

    dispatchLoadFailure(webview, { errorCode: -105, isMainFrame: false })
    dispatchLoadFailure(webview, { errorCode: -3, isMainFrame: true })
    webview.dispatchEvent(new Event('did-stop-loading'))

    expect(screen.queryByText('Preview unavailable')).not.toBeInTheDocument()
  })

  it('stops waiting when navigation stalls', async () => {
    vi.useFakeTimers()
    render(<ArtifactPreview shareUrl="https://share.onorca.dev/a/report" />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(document.querySelector('webview')).not.toBeNull()

    act(() => vi.advanceTimersByTime(20_000))

    expect(screen.getByText('Preview unavailable')).toBeInTheDocument()
  })

  it('stops waiting when preview-session resolution stalls', () => {
    vi.useFakeTimers()
    vi.mocked(window.api.browser.sessionResolvePartition).mockReturnValue(new Promise(() => {}))
    render(<ArtifactPreview shareUrl="https://share.onorca.dev/a/report" />)

    act(() => vi.advanceTimersByTime(20_000))

    expect(screen.getByText('Preview unavailable')).toBeInTheDocument()
  })
})
