// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAppStartup: vi.fn(),
  setAppStartup: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

import { GeneralStartupSettingsSection } from './GeneralStartupSettingsSection'

describe('GeneralStartupSettingsSection', () => {
  beforeEach(() => {
    mocks.getAppStartup.mockReset()
    mocks.setAppStartup.mockReset()
    mocks.toastError.mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        settings: {
          getAppStartup: mocks.getAppStartup,
          setAppStartup: mocks.setAppStartup
        }
      }
    })
  })

  afterEach(cleanup)

  it('loads the native state and updates it through the settings API', async () => {
    mocks.getAppStartup.mockResolvedValue({
      supported: true,
      canModify: true,
      openAtLogin: false
    })
    mocks.setAppStartup.mockResolvedValue({
      supported: true,
      canModify: true,
      openAtLogin: true
    })
    const user = userEvent.setup()
    render(<GeneralStartupSettingsSection />)

    const toggle = await screen.findByRole('switch', { name: 'Launch Orca at login' })
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    await user.click(toggle)
    expect(mocks.setAppStartup).toHaveBeenCalledWith({ openAtLogin: true })
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
  })

  it('keeps the switch disabled outside an installed desktop build', async () => {
    mocks.getAppStartup.mockResolvedValue({
      supported: true,
      canModify: false,
      openAtLogin: false
    })
    render(<GeneralStartupSettingsSection />)

    const toggle = await screen.findByRole('switch', { name: 'Launch Orca at login' })
    await waitFor(() => expect(toggle).toBeDisabled())
    expect(screen.getByText('Available in the installed desktop app.')).toBeInTheDocument()
  })
})
