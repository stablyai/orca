// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BrowserLoadFailureOverlay } from './browser-load-failure-overlay'

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
