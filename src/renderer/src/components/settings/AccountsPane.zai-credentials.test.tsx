// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { getDefaultSettings } from '../../../../shared/constants'
import { AccountsPane } from './AccountsPane'

const storeState = {
  settingsSearchQuery: 'z.ai',
  rateLimits: {
    minimax: null,
    zai: null,
    codex: null,
    codexTarget: { runtime: 'host' as const }
  },
  runtimeEnvironments: [],
  fetchSettings: vi.fn(),
  recordFeatureInteraction: vi.fn()
}

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))

describe('AccountsPane Z.ai credentials', () => {
  const getStatus = vi.fn()
  const saveApiKey = vi.fn()
  const clearApiKey = vi.fn()

  beforeEach(() => {
    getStatus.mockResolvedValue({ configured: false })
    saveApiKey.mockResolvedValue({ configured: true })
    clearApiKey.mockResolvedValue({ configured: false })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        claudeAccounts: { list: vi.fn().mockResolvedValue({ accounts: [] }) },
        codexAccounts: { list: vi.fn().mockResolvedValue({ accounts: [] }) },
        minimaxCredentials: { getStatus: vi.fn().mockResolvedValue({ configured: false }) },
        zaiCredentials: { getStatus, saveApiKey, clearApiKey }
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('saves, replaces, and forgets the key without rendering it back', async () => {
    const user = userEvent.setup()
    render(<AccountsPane settings={getDefaultSettings('/tmp')} updateSettings={vi.fn()} />)

    const input = screen.getByPlaceholderText('Enter API key')
    expect(input).toHaveAttribute('type', 'password')

    await user.type(input, 'test-zai-key-not-secret')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(saveApiKey).toHaveBeenCalledWith('test-zai-key-not-secret')
    expect(input).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Replace' })).toBeVisible()

    await user.type(input, 'replacement-zai-key-not-secret')
    await user.click(screen.getByRole('button', { name: 'Replace' }))
    expect(saveApiKey).toHaveBeenLastCalledWith('replacement-zai-key-not-secret')
    expect(input).toHaveValue('')

    await user.click(screen.getByRole('button', { name: 'Forget key' }))
    expect(clearApiKey).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Save' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Forget key' })).toBeNull()
    expect(input).toHaveValue('')
  })

  it('does not let a stale initial status overwrite a successful save', async () => {
    let resolveInitialStatus: ((status: { configured: boolean }) => void) | undefined
    getStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInitialStatus = resolve
      })
    )
    const user = userEvent.setup()
    render(<AccountsPane settings={getDefaultSettings('/tmp')} updateSettings={vi.fn()} />)

    await user.type(screen.getByPlaceholderText('Enter API key'), 'test-zai-key-not-secret')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByRole('button', { name: 'Replace' })).toBeVisible()

    await act(async () => {
      resolveInitialStatus?.({ configured: false })
    })

    expect(screen.getByRole('button', { name: 'Replace' })).toBeVisible()
  })
})
