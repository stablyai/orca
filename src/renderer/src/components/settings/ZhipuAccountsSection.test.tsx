// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  save: vi.fn(),
  clear: vi.fn(),
  importFromCcSwitch: vi.fn(),
  refreshZhipuRateLimits: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) => {
    let result = fallback
    for (const [key, value] of Object.entries(values ?? {})) {
      result = result.replace(`{{${key}}}`, value)
    }
    return result
  }
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settingsSearchQuery: '',
      refreshZhipuRateLimits: mocks.refreshZhipuRateLimits,
      rateLimits: { zhipu: null }
    })
}))

import { ZhipuAccountsSection } from './ZhipuAccountsSection'

describe('ZhipuAccountsSection', () => {
  beforeEach(() => {
    mocks.getStatus.mockResolvedValue({
      configured: true,
      baseUrl: 'https://open.bigmodel.cn/api/anthropic'
    })
    mocks.save.mockResolvedValue({
      configured: true,
      baseUrl: 'https://open.bigmodel.cn/api/anthropic'
    })
    mocks.clear.mockResolvedValue({
      configured: false,
      baseUrl: null
    })
    mocks.importFromCcSwitch.mockResolvedValue({
      configured: true,
      baseUrl: 'https://api.z.ai/api/anthropic',
      importedProviderName: 'bigmodel'
    })
    mocks.refreshZhipuRateLimits.mockResolvedValue(undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        zhipuCredentials: {
          getStatus: mocks.getStatus,
          save: mocks.save,
          clear: mocks.clear,
          importFromCcSwitch: mocks.importFromCcSwitch
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('loads configured Zhipu credential status without exposing the token', async () => {
    render(<ZhipuAccountsSection />)

    expect(await screen.findByText('https://open.bigmodel.cn/api/anthropic')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Stored; paste a new token to replace')).toBeInTheDocument()
  })

  it('saves a replacement token through the desktop API', async () => {
    const user = userEvent.setup()
    render(<ZhipuAccountsSection />)

    await screen.findByText('https://open.bigmodel.cn/api/anthropic')
    await user.type(screen.getByLabelText('ANTHROPIC_AUTH_TOKEN'), 'zai-token')
    await user.click(screen.getByRole('button', { name: 'Replace token' }))

    await waitFor(() => {
      expect(mocks.save).toHaveBeenCalledWith({
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        authToken: 'zai-token'
      })
    })
    expect(mocks.refreshZhipuRateLimits).toHaveBeenCalled()
  })

  it('imports the current cc-switch provider without exposing its token', async () => {
    const user = userEvent.setup()
    render(<ZhipuAccountsSection />)

    await user.click(await screen.findByRole('button', { name: 'Import from cc-switch' }))

    await waitFor(() => {
      expect(mocks.importFromCcSwitch).toHaveBeenCalled()
    })
    expect(await screen.findByText('https://api.z.ai/api/anthropic')).toBeInTheDocument()
    expect(
      screen.getByText('Imported current cc-switch Claude provider: bigmodel.')
    ).toBeInTheDocument()
    expect(screen.queryByDisplayValue('zai-token')).not.toBeInTheDocument()
    expect(mocks.refreshZhipuRateLimits).toHaveBeenCalled()
  })
})
