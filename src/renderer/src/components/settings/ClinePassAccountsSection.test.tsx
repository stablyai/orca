// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  saveApiKey: vi.fn(),
  clearApiKey: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: ({ agent }: { agent: string }) =>
    React.createElement('span', { 'data-testid': 'agent-icon' }, agent)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess }
}))

vi.mock('./SearchableSetting', () => ({
  SearchableSetting: ({ children }: { children: React.ReactNode }) => children
}))

import { ClinePassAccountsSection } from './ClinePassAccountsSection'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('ClinePassAccountsSection', () => {
  beforeEach(() => {
    mocks.getStatus.mockResolvedValue({ configured: false, source: 'none' })
    mocks.saveApiKey.mockResolvedValue({ configured: true, source: 'stored' })
    mocks.clearApiKey.mockResolvedValue({ configured: false, source: 'none' })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        clinePassCredentials: {
          getStatus: mocks.getStatus,
          saveApiKey: mocks.saveApiKey,
          clearApiKey: mocks.clearApiKey
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows the unconfigured subscription quota state', async () => {
    render(<ClinePassAccountsSection />)

    expect(await screen.findByText('API key not configured')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Forget API key' })).not.toBeInTheDocument()
    expect(screen.getByText(/5-hour, weekly, and monthly windows/i)).toBeInTheDocument()
    expect(screen.getByTestId('agent-icon')).toHaveTextContent('cline')
  })

  it('shows a stored credential without loading or echoing its secret', async () => {
    const storedSecret = 'cline-stored-secret-that-must-not-render'
    mocks.getStatus.mockResolvedValue({
      configured: true,
      source: 'stored',
      apiKey: storedSecret
    })

    render(<ClinePassAccountsSection />)

    expect(await screen.findByText('API key saved in Orca')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Replace' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Forget API key' })).toBeEnabled()
    expect(screen.getByLabelText('ClinePass API key')).toHaveValue('')
    expect(document.body.textContent).not.toContain(storedSecret)
  })

  it('explains environment configuration and does not offer to clear it', async () => {
    mocks.getStatus.mockResolvedValue({ configured: true, source: 'environment' })

    render(<ClinePassAccountsSection />)

    expect(await screen.findByText('Configured by CLINE_API_KEY')).toBeInTheDocument()
    expect(screen.getByText(/cannot be cleared here/i)).toBeInTheDocument()
    expect(screen.getByText(/saved key overrides the environment/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Forget API key' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    expect(screen.getByRole('link', { name: 'API key docs' })).toHaveAttribute(
      'href',
      'https://docs.cline.bot/api/authentication'
    )
  })

  it.each([
    { source: 'none', action: 'Save' },
    { source: 'stored', action: 'Replace' }
  ] as const)(
    '$action stores a trimmed local draft and clears it on success',
    async ({ source, action }) => {
      mocks.getStatus.mockResolvedValue({ configured: source === 'stored', source })
      render(<ClinePassAccountsSection />)
      const input = screen.getByLabelText('ClinePass API key')
      await screen.findByRole('button', { name: action })

      fireEvent.change(input, { target: { value: '  cline-test-key  ' } })
      fireEvent.click(screen.getByRole('button', { name: action }))

      await waitFor(() => expect(mocks.saveApiKey).toHaveBeenCalledWith('cline-test-key'))
      expect(input).toHaveValue('')
      expect(screen.getByRole('button', { name: 'Replace' })).toBeEnabled()
      expect(mocks.toastSuccess).toHaveBeenCalledWith('ClinePass API key saved.')
    }
  )

  it('forgets only the stored credential and adopts the returned status', async () => {
    mocks.getStatus.mockResolvedValue({ configured: true, source: 'stored' })
    render(<ClinePassAccountsSection />)
    const forget = await screen.findByRole('button', { name: 'Forget API key' })

    fireEvent.click(forget)

    await waitFor(() => expect(mocks.clearApiKey).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('API key not configured')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Forget API key' })).not.toBeInTheDocument()
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Stored ClinePass API key forgotten.')
  })

  it('validates an empty draft before calling the credential API', async () => {
    render(<ClinePassAccountsSection />)
    const save = await screen.findByRole('button', { name: 'Save' })

    fireEvent.click(save)

    expect(mocks.saveApiKey).not.toHaveBeenCalled()
    expect(screen.getByLabelText('ClinePass API key')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('ClinePass API key is required.')
    expect(mocks.toastError).toHaveBeenCalledWith('ClinePass API key is required.')
  })

  it('blocks duplicate saves, retains the draft on failure, and does not echo error secrets', async () => {
    const pending = deferred<{ configured: boolean; source: 'stored' }>()
    const draft = 'cline-private-draft'
    mocks.saveApiKey.mockReturnValue(pending.promise)
    render(<ClinePassAccountsSection />)
    const save = await screen.findByRole('button', { name: 'Save' })
    const input = screen.getByLabelText('ClinePass API key')
    fireEvent.change(input, { target: { value: draft } })

    fireEvent.click(save)
    fireEvent.click(save)

    expect(mocks.saveApiKey).toHaveBeenCalledTimes(1)
    expect(save).toBeDisabled()
    expect(input).toBeDisabled()

    await act(async () => {
      pending.reject(new Error(`request failed for ${draft}`))
    })

    expect(input).toHaveValue(draft)
    expect(save).toBeEnabled()
    expect(mocks.toastError).toHaveBeenCalledWith(
      'ClinePass API key could not be saved. Check the key and try again.'
    )
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(draft)
  })

  it('blocks duplicate forget actions and keeps stored status on failure', async () => {
    const pending = deferred<{ configured: boolean; source: 'none' }>()
    mocks.getStatus.mockResolvedValue({ configured: true, source: 'stored' })
    mocks.clearApiKey.mockReturnValue(pending.promise)
    render(<ClinePassAccountsSection />)
    const forget = await screen.findByRole('button', { name: 'Forget API key' })

    fireEvent.click(forget)
    fireEvent.click(forget)

    expect(mocks.clearApiKey).toHaveBeenCalledTimes(1)
    expect(forget).toBeDisabled()

    await act(async () => {
      pending.reject(new Error('storage unavailable'))
    })

    expect(screen.getByText('API key saved in Orca')).toBeInTheDocument()
    expect(forget).toBeEnabled()
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Stored ClinePass API key could not be forgotten. Try again.'
    )
  })

  it('reports status load failures without exposing an API value', async () => {
    mocks.getStatus.mockRejectedValue(new Error('cline-secret-from-error'))
    render(<ClinePassAccountsSection />)

    expect(await screen.findByText('Credential status unavailable')).toBeInTheDocument()
    expect(mocks.toastError).toHaveBeenCalledWith(
      'ClinePass credential status could not be loaded.'
    )
    expect(document.body.textContent).not.toContain('cline-secret-from-error')
  })

  it('recovers from an initial status error after a successful save', async () => {
    mocks.getStatus.mockRejectedValue(new Error('status unavailable'))
    render(<ClinePassAccountsSection />)
    expect(await screen.findByText('Credential status unavailable')).toBeInTheDocument()
    const input = screen.getByLabelText('ClinePass API key')
    fireEvent.change(input, { target: { value: 'cline-recovery-key' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('API key saved in Orca')).toBeInTheDocument()
    expect(screen.queryByText('Credential status unavailable')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Replace' })).toBeEnabled()
  })
})
