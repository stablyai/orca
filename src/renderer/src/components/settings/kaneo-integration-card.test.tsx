// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KaneoIntegrationCard } from './kaneo-integration-card'
import { getKaneoApi } from '@/runtime/runtime-kaneo-client'

vi.mock('@/runtime/runtime-kaneo-client', () => ({ getKaneoApi: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({ settings: null })
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./integration-card-shell', () => ({
  IntegrationCardShell: ({
    name,
    actions,
    children,
    statusLabel
  }: {
    name: string
    actions: React.ReactNode
    children: React.ReactNode
    statusLabel: string
  }) => (
    <section>
      <h2>{name}</h2>
      {statusLabel}
      {actions}
      {children}
    </section>
  ),
  IntegrationCardDetails: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe('Kaneo connection settings', () => {
  it('uses a password input, validates the connection, and removes the key from the form', async () => {
    const connect = vi
      .fn()
      .mockResolvedValue({ connected: true, siteUrl: 'https://tasks.example.com' })
    vi.mocked(getKaneoApi).mockReturnValue({
      status: async () => ({ connected: false, siteUrl: null }),
      connect
    } as never)
    render(<KaneoIntegrationCard />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Connect Kaneo' }).hasAttribute('disabled')).toBe(
        false
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Connect Kaneo' }))
    fireEvent.change(screen.getByLabelText('Instance URL'), {
      target: { value: 'https://tasks.example.com' }
    })
    const key = screen.getByLabelText('API key') as HTMLInputElement
    expect(key.type).toBe('password')
    fireEvent.change(key, { target: { value: 'test-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
    await waitFor(() => expect(screen.queryByLabelText('API key')).toBeNull())
    expect(connect).toHaveBeenCalledWith({
      siteUrl: 'https://tasks.example.com',
      apiKey: 'test-key'
    })
    fireEvent.click(screen.getByRole('button', { name: 'Configure' }))
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('')
  })

  it('offers retry when runtime status is unavailable', async () => {
    const status = vi
      .fn()
      .mockRejectedValueOnce(new Error('Runtime disconnected'))
      .mockResolvedValueOnce({ connected: false, siteUrl: null })
    vi.mocked(getKaneoApi).mockReturnValue({ status } as never)
    render(<KaneoIntegrationCard />)
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Connect Kaneo' }).hasAttribute('disabled')).toBe(
        false
      )
    )
    expect(status).toHaveBeenCalledTimes(2)
  })
  it('restores the saved instance and clears the key when edits are cancelled', async () => {
    vi.mocked(getKaneoApi).mockReturnValue({
      status: async () => ({ connected: true, siteUrl: 'https://tasks.example.com' })
    } as never)
    render(<KaneoIntegrationCard />)
    fireEvent.click(await screen.findByRole('button', { name: 'Configure' }))
    fireEvent.change(screen.getByLabelText('Instance URL'), {
      target: { value: 'https://unsaved.example' }
    })
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'unsaved-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Configure' }))
    expect((screen.getByLabelText('Instance URL') as HTMLInputElement).value).toBe(
      'https://tasks.example.com'
    )
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('')
  })
})
