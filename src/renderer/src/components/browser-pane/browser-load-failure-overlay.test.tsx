// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BrowserLoadFailureOverlay } from './browser-load-failure-overlay'

const callbacks = {
  onRetry: vi.fn(),
  onTryHttps: vi.fn(),
  onCopy: vi.fn(),
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
  it('uses certificate-specific copy while keeping strict verification', () => {
    render(
      <BrowserLoadFailureOverlay
        loadError={{
          code: -202,
          description: 'ERR_CERT_AUTHORITY_INVALID',
          validatedUrl: 'https://localhost:3443/app'
        }}
        externalUrl="https://localhost:3443/app"
        currentUrl="https://localhost:3443/app"
        httpsRecoveryUrl={null}
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
        currentUrl="https://localhost:3443/"
        httpsRecoveryUrl={null}
        {...callbacks}
      />
    )

    expect(screen.getByText("The certificate doesn't match localhost:3443.")).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Proceed Anyway (Unsafe)' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Copy Address' })).toBeEnabled()
  })

  it('offers HTTPS recovery only for an eligible failed HTTP address', () => {
    const { rerender } = render(
      <BrowserLoadFailureOverlay
        loadError={{
          code: -102,
          description: 'ERR_CONNECTION_REFUSED',
          validatedUrl: 'http://localhost:3000/app'
        }}
        externalUrl="http://localhost:3000/app"
        currentUrl="http://localhost:3000/app"
        httpsRecoveryUrl="https://localhost:3000/app"
        {...callbacks}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Try HTTPS' }))
    expect(callbacks.onTryHttps).toHaveBeenCalledWith('https://localhost:3000/app')

    rerender(
      <BrowserLoadFailureOverlay
        loadError={{
          code: -102,
          description: 'ERR_CONNECTION_REFUSED',
          validatedUrl: 'https://localhost:3000/app'
        }}
        externalUrl="https://localhost:3000/app"
        currentUrl="https://localhost:3000/app"
        httpsRecoveryUrl={null}
        {...callbacks}
      />
    )
    expect(screen.queryByRole('button', { name: 'Try HTTPS' })).toBeNull()
  })

  it('hides Open Externally and works without an external handler', () => {
    render(
      <BrowserLoadFailureOverlay
        loadError={{
          code: -202,
          description: 'ERR_CERT_AUTHORITY_INVALID',
          validatedUrl: 'https://localhost:3443/'
        }}
        currentUrl="https://localhost:3443/"
        httpsRecoveryUrl={null}
        onRetry={callbacks.onRetry}
        onTryHttps={callbacks.onTryHttps}
        onCopy={callbacks.onCopy}
      />
    )

    // externalUrl / onOpenExternal omitted (e.g. a remote loopback failure):
    // the action is absent and the overlay still renders its other recovery UI.
    expect(screen.queryByRole('button', { name: 'Open Externally' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Copy Address' })).toBeEnabled()
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
        currentUrl="https://example.com/"
        httpsRecoveryUrl={null}
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
        currentUrl="https://localhost:3443/app"
        httpsRecoveryUrl={null}
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
        currentUrl="https://localhost:3443/app"
        httpsRecoveryUrl={null}
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
        currentUrl="https://localhost:3444/app"
        httpsRecoveryUrl={null}
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
        currentUrl="https://localhost:3443/app"
        httpsRecoveryUrl={null}
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
        currentUrl="https://localhost:3443/app"
        httpsRecoveryUrl={null}
        certificateFailure={certificateFailure}
        expectedBrowserPageId="page-1"
        {...callbacks}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Proceed Anyway (Unsafe)' }))
    expect(callbacks.onProceedCertificate).toHaveBeenCalledWith('challenge-1')
    for (const name of ['Proceed Anyway (Unsafe)', 'Open Externally', 'Retry', 'Copy Address']) {
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
        currentUrl="https://localhost:3443/app"
        httpsRecoveryUrl={null}
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
      currentUrl: 'https://localhost:3443/app',
      httpsRecoveryUrl: null,
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
