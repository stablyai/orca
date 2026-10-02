// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { SyntheticAccountsSection } from './SyntheticAccountsSection'

const fake = vi.hoisted(() => {
  const state: { usage: ProviderRateLimits | null; refresh: ReturnType<typeof vi.fn> } = {
    usage: null,
    refresh: vi.fn()
  }
  return state
})
vi.mock('@/store', () => ({
  useAppStore: (selector: (s: unknown) => unknown) =>
    selector({ rateLimits: { synthetic: fake.usage }, refreshRateLimits: fake.refresh })
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, text: string, values?: Record<string, string | number>) =>
    Object.entries(values ?? {}).reduce(
      (result, [key, value]) => result.replaceAll(`{{${key}}}`, String(value)),
      text
    )
}))
vi.mock('./SearchableSetting', () => ({
  SearchableSetting: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

beforeEach(() => {
  fake.usage = null
  fake.refresh.mockReset().mockResolvedValue(undefined)
})
afterEach(cleanup)

it('shows setup and allows clearing the API key', () => {
  const updateSettings = vi.fn()
  render(
    <SyntheticAccountsSection
      settings={{ ...getDefaultSettings('/home/test'), syntheticApiKey: 'placeholder' }}
      updateSettings={updateSettings}
    />
  )
  expect(screen.getByLabelText('Synthetic API key').getAttribute('type')).toBe('password')
  fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
  expect(updateSettings).toHaveBeenCalledWith({ syntheticApiKey: '' })
  expect(screen.getByRole('link', { name: 'Quota docs' }).getAttribute('href')).toContain(
    '/synthetic/quotas'
  )
})

it('shows counts and renewal, including an error beside stale data', () => {
  fake.usage = {
    provider: 'synthetic',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    status: 'error',
    error: 'Synthetic quota request failed',
    requestQuota: { requests: 27, limit: 135, renewsAt: Date.parse('2026-10-01T14:36:14Z') }
  }
  render(
    <SyntheticAccountsSection
      settings={getDefaultSettings('/home/test')}
      updateSettings={vi.fn()}
    />
  )
  expect(screen.getByText('27 / 135 requests used')).toBeTruthy()
  expect(screen.getByText('Request usage')).toBeTruthy()
  expect(screen.queryByText('Five-hour request usage')).toBeNull()
  expect(screen.getByText(/^Renews /)).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toContain('failed')
})

it('disables refresh while pending and displays refresh failures', async () => {
  let reject!: (reason: Error) => void
  fake.refresh.mockImplementation(
    () =>
      new Promise((_, fail) => {
        reject = fail
      })
  )
  render(
    <SyntheticAccountsSection
      settings={getDefaultSettings('/home/test')}
      updateSettings={vi.fn()}
    />
  )
  const button = screen.getByRole('button', { name: 'Refresh usage' })
  fireEvent.click(button)
  expect(button.hasAttribute('disabled')).toBe(true)
  reject(new Error('Unavailable'))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not refresh'))
  expect(button.hasAttribute('disabled')).toBe(false)
})
