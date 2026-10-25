// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BrowserLoadFailureOverlay } from './browser-load-failure-overlay'
import { BROWSER_GUEST_RECOVERY_ERROR_CODE } from '../host-guest/browser-page-guest-recovery'

const callbacks = {
  onRetry: vi.fn(),
  onOpenExternal: vi.fn(),
  onProceedCertificate: vi.fn()
}

const certificateFailure = {
  challengeId: 'challenge-1',
  browserPageId: 'page-1',
  errorCode: -202,
  error: 'ERR_CERT_AUTHORITY_INVALID',
  origin: 'https://localhost:3443',
  displayHost: 'localhost:3443',
  canProceed: true,
  observedAt: 123
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('BrowserLoadFailureOverlay', () => {
  it('waits for a local dev server, re-attempting the load with backoff until it gives up', async () => {
    vi.useFakeTimers()
    const refused = () => ({
      code: -102,
      description: 'ERR_CONNECTION_REFUSED',
      validatedUrl: 'http://localhost:3000/'
    })
    const view = (loading: boolean) => (
      <BrowserLoadFailureOverlay
        loadError={refused()}
        autoRetry={{ active: true, loading }}
        {...callbacks}
      />
    )
    const { rerender } = render(view(false))
    expect(screen.getByText('Nothing is running on localhost:3000 yet')).toBeInTheDocument()
    expect(screen.getByText('ERR_CONNECTION_REFUSED')).toBeInTheDocument()
    expect(screen.getByText(/Reloads when the server starts/)).toBeInTheDocument()

    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(callbacks.onRetry).toHaveBeenCalledTimes(1)
    // An attempt in flight is left to settle, not aborted by the next one.
    rerender(view(true))
    await act(() => vi.advanceTimersByTimeAsync(5000))
    expect(callbacks.onRetry).toHaveBeenCalledTimes(1)
    // Each failed attempt delivers a fresh error object; the backoff carries on.
    rerender(view(false))
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(callbacks.onRetry).toHaveBeenCalledTimes(2)
    await act(() => vi.advanceTimersByTimeAsync(1999))
    expect(callbacks.onRetry).toHaveBeenCalledTimes(2)
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(callbacks.onRetry).toHaveBeenCalledTimes(3)

    // Every 5s after that, for 120 attempts in all; then it stops saying it will reload.
    await act(() => vi.advanceTimersByTimeAsync(3000 + 116 * 5000))
    expect(callbacks.onRetry).toHaveBeenCalledTimes(120)
    expect(screen.queryByText(/Reloads when the server starts/)).toBeNull()
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(callbacks.onRetry).toHaveBeenCalledTimes(120)
  })

  it('stays still while the page is not on screen or the failure is not one waiting can fix', () => {
    vi.useFakeTimers()
    const { rerender } = render(
      <BrowserLoadFailureOverlay
        loadError={{
          code: -102,
          description: 'ERR_CONNECTION_REFUSED',
          validatedUrl: 'http://localhost:3000/'
        }}
        autoRetry={{ active: false, loading: false }}
        {...callbacks}
      />
    )
    rerender(
      <BrowserLoadFailureOverlay
        loadError={{
          code: -105,
          description: 'ERR_NAME_NOT_RESOLVED',
          validatedUrl: 'https://example.com/'
        }}
        autoRetry={{ active: true, loading: false }}
        {...callbacks}
      />
    )
    expect(screen.getByText("Couldn't find example.com")).toBeInTheDocument()
    expect(screen.queryByText(/Waiting for/)).toBeNull()
    act(() => vi.advanceTimersByTime(60_000))
    expect(callbacks.onRetry).not.toHaveBeenCalled()
  })

  it('never starts an attempt while the previous one is still settling', async () => {
    vi.useFakeTimers()
    let settle = (): void => {}
    callbacks.onRetry.mockImplementationOnce(
      () => new Promise<void>((resolve) => (settle = resolve))
    )
    render(
      <BrowserLoadFailureOverlay
        loadError={{
          code: -120,
          description: 'ERR_SOCKS_CONNECTION_FAILED',
          validatedUrl: 'http://localhost:3000/'
        }}
        route={{ routed: true, routeConnected: true }}
        autoRetry={{ active: true, loading: false }}
        {...callbacks}
      />
    )
    await act(() => vi.advanceTimersByTimeAsync(1000))
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(callbacks.onRetry).toHaveBeenCalledTimes(1)
    await act(async () => settle())
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(callbacks.onRetry).toHaveBeenCalledTimes(2)
  })

  it('waits while offline, then keeps re-attempting once the network is back', async () => {
    vi.useFakeTimers()
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    render(
      <BrowserLoadFailureOverlay
        loadError={{
          code: -106,
          description: 'ERR_INTERNET_DISCONNECTED',
          validatedUrl: 'https://example.com/'
        }}
        autoRetry={{ active: true, loading: false }}
        {...callbacks}
      />
    )
    expect(screen.getByText("You're offline")).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(callbacks.onRetry).not.toHaveBeenCalled()

    // `online` can fire before DNS works, so one failed attempt doesn't end the wait.
    onLine.mockReturnValue(true)
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(callbacks.onRetry).toHaveBeenCalledTimes(1)
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(callbacks.onRetry).toHaveBeenCalledTimes(2)
    onLine.mockRestore()
  })

  it('offers the connection-check undo only when a routed page provides it', () => {
    const onRecheckSshRoute = vi.fn()
    const loadError = {
      code: -102,
      description: 'ERR_CONNECTION_REFUSED',
      url: 'https://example.com/',
      validatedUrl: 'https://example.com/'
    }
    const { rerender } = render(
      <BrowserLoadFailureOverlay
        loadError={loadError}
        sshRoutedHint
        onRecheckSshRoute={onRecheckSshRoute}
        {...callbacks}
      />
    )
    fireEvent.click(screen.getByTestId('browser-load-failure-recheck-ssh-route'))
    expect(onRecheckSshRoute).toHaveBeenCalledTimes(1)

    // Without a persisted Try-anyway there is nothing to undo — no dangling link.
    rerender(
      <BrowserLoadFailureOverlay
        loadError={loadError}
        sshRoutedHint
        onRecheckSshRoute={null}
        {...callbacks}
      />
    )
    expect(screen.queryByTestId('browser-load-failure-recheck-ssh-route')).toBeNull()
  })

  it('uses certificate-specific copy while keeping strict verification', () => {
    render(
      <BrowserLoadFailureOverlay
        loadError={{
          code: -202,
          description: 'ERR_CERT_AUTHORITY_INVALID',
          validatedUrl: 'https://localhost:3443/app'
        }}
        externalUrl="https://localhost:3443/app"
        {...callbacks}
      />
    )

    expect(screen.getByText("Connection isn't secure")).toBeInTheDocument()
    expect(
      screen.getByText(
        "Orca doesn't trust the authority that issued the certificate for localhost:3443."
      )
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Proceed Anyway (Unsafe)' })).toBeNull()
    expect(screen.queryByText(/make sure the server is running/i)).not.toBeInTheDocument()
  })

  it('keeps restored certificate errors accurate without allowing approval', () => {
    render(
      <BrowserLoadFailureOverlay
        loadError={{
          code: -200,
          description: 'ERR_CERT_COMMON_NAME_INVALID',
          validatedUrl: 'https://localhost:3443/'
        }}
        externalUrl={null}
        {...callbacks}
      />
    )

    expect(screen.getByText("The certificate doesn't match localhost:3443.")).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Proceed Anyway (Unsafe)' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
  })

  it('presents guest recovery failures without network troubleshooting', () => {
    render(
      <BrowserLoadFailureOverlay
        loadError={{
          code: BROWSER_GUEST_RECOVERY_ERROR_CODE,
          description: 'The browser page stopped unexpectedly. Retry to restore it.',
          validatedUrl: 'http://localhost:3000/app'
        }}
        externalUrl="http://localhost:3000/app"
        {...callbacks}
      />
    )

    expect(screen.getByText('Browser page stopped')).toBeInTheDocument()
    expect(
      screen.getByText('The browser page stopped unexpectedly. Retry to restore it.')
    ).toBeInTheDocument()
    expect(screen.queryByText(/make sure the server is running/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
  })

  it('hides Open Externally and works without an external handler', () => {
    render(
      <BrowserLoadFailureOverlay
        loadError={{
          code: -202,
          description: 'ERR_CERT_AUTHORITY_INVALID',
          validatedUrl: 'https://localhost:3443/'
        }}
        onRetry={callbacks.onRetry}
      />
    )

    // Remote loopback failures omit the external-open action but retain recovery controls.
    expect(screen.queryByRole('button', { name: 'Open Externally' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
  })

  it('does not show local-certificate guidance for a public-host failure', () => {
    render(
      <BrowserLoadFailureOverlay
        loadError={{
          code: -202,
          description: 'ERR_CERT_AUTHORITY_INVALID',
          validatedUrl: 'https://example.com/'
        }}
        externalUrl="https://example.com/"
        {...callbacks}
      />
    )

    expect(screen.queryByText(/use a trusted local certificate/i)).not.toBeInTheDocument()
  })

  it('offers approval only for a matching live challenge', () => {
    const { rerender } = render(
      <BrowserLoadFailureOverlay
        loadError={{
          code: -202,
          description: 'ERR_CERT_AUTHORITY_INVALID',
          validatedUrl: 'https://localhost:3443/app'
        }}
        externalUrl={null}
        certificateFailure={certificateFailure}
        expectedBrowserPageId="page-1"
        {...callbacks}
      />
    )

    expect(screen.getByRole('button', { name: 'Proceed Anyway (Unsafe)' })).toBeEnabled()

    rerender(
      <BrowserLoadFailureOverlay
        loadError={{
          code: -1,
          description: 'ERR_FAILED',
          validatedUrl: 'https://localhost:3443/app'
        }}
        externalUrl={null}
        certificateFailure={certificateFailure}
        expectedBrowserPageId="page-1"
        {...callbacks}
      />
    )
    expect(screen.getByText("Connection isn't secure")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Proceed Anyway (Unsafe)' })).toBeEnabled()

    rerender(
      <BrowserLoadFailureOverlay
        loadError={{
          code: -202,
          description: 'ERR_CERT_AUTHORITY_INVALID',
          validatedUrl: 'https://localhost:3444/app'
        }}
        externalUrl={null}
        certificateFailure={certificateFailure}
        expectedBrowserPageId="page-1"
        {...callbacks}
      />
    )
    expect(screen.queryByRole('button', { name: 'Proceed Anyway (Unsafe)' })).toBeNull()

    rerender(
      <BrowserLoadFailureOverlay
        loadError={{
          code: -202,
          description: 'ERR_CERT_AUTHORITY_INVALID',
          validatedUrl: 'https://localhost:3443/app'
        }}
        externalUrl={null}
        certificateFailure={certificateFailure}
        expectedBrowserPageId="other-page"
        {...callbacks}
      />
    )
    expect(screen.queryByRole('button', { name: 'Proceed Anyway (Unsafe)' })).toBeNull()
  })

  it('disables every action immediately and delays connecting feedback', async () => {
    vi.useFakeTimers()
    let resolveProceed: ((result: { ok: true }) => void) | null = null
    callbacks.onProceedCertificate.mockReturnValue(
      new Promise((resolve) => {
        resolveProceed = resolve
      })
    )
    const { rerender } = render(
      <BrowserLoadFailureOverlay
        loadError={{
          code: -202,
          description: 'ERR_CERT_AUTHORITY_INVALID',
          validatedUrl: 'https://localhost:3443/app'
        }}
        externalUrl="https://localhost:3443/app"
        certificateFailure={certificateFailure}
        expectedBrowserPageId="page-1"
        {...callbacks}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Proceed Anyway (Unsafe)' }))
    expect(callbacks.onProceedCertificate).toHaveBeenCalledWith('challenge-1')
    for (const name of ['Proceed Anyway (Unsafe)', 'Open Externally', 'Retry']) {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    }
    expect(screen.queryByText('Connecting…')).toBeNull()

    act(() => vi.advanceTimersByTime(199))
    expect(screen.queryByText('Connecting…')).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByRole('button', { name: 'Connecting…' })).toBeDisabled()

    await act(async () => resolveProceed?.({ ok: true }))
    rerender(
      <BrowserLoadFailureOverlay
        loadError={{
          code: -202,
          description: 'ERR_CERT_AUTHORITY_INVALID',
          validatedUrl: 'https://localhost:3443/app'
        }}
        externalUrl="https://localhost:3443/app"
        certificateFailure={null}
        expectedBrowserPageId="page-1"
        {...callbacks}
      />
    )
    expect(screen.queryByRole('button', { name: 'Proceed Anyway (Unsafe)' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
  })

  it('recovers from typed approval failures and resets for a new challenge', async () => {
    callbacks.onProceedCertificate.mockResolvedValue({ ok: false, reason: 'expired' })
    const props = {
      loadError: {
        code: -202,
        description: 'ERR_CERT_AUTHORITY_INVALID',
        validatedUrl: 'https://localhost:3443/app'
      },
      externalUrl: null,
      expectedBrowserPageId: 'page-1',
      ...callbacks
    }
    const { rerender } = render(
      <BrowserLoadFailureOverlay {...props} certificateFailure={certificateFailure} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Proceed Anyway (Unsafe)' }))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/certificate approval expired/i)
    )
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()

    callbacks.onProceedCertificate.mockReturnValue(new Promise(() => {}))
    fireEvent.click(screen.getByRole('button', { name: 'Proceed Anyway (Unsafe)' }))
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled()
    rerender(
      <BrowserLoadFailureOverlay
        {...props}
        certificateFailure={{ ...certificateFailure, challengeId: 'challenge-2' }}
      />
    )
    expect(screen.getByRole('button', { name: 'Proceed Anyway (Unsafe)' })).toBeEnabled()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
