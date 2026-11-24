// @vitest-environment happy-dom
import { act } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GoogleAccountPickerRow } from './GoogleAccountPicker'
import { giveBotGoogleAccount } from './give-bot-google-account'

const setBotGoogle = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())
vi.mock('./set-bot-google', () => ({ setBotGoogle }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('a Google account row', () => {
  it('toggles from the keyboard, and Reconnect is its own control', async () => {
    const onToggle = vi.fn()
    const onReconnect = vi.fn()
    render(
      <GoogleAccountPickerRow
        account={{ email: 'me@gmail.com', status: 'reconnect', services: [], connectedAt: 0 }}
        on
        onToggle={onToggle}
        onReconnect={onReconnect}
      />
    )
    const user = userEvent.setup()
    const toggle = screen.getByRole('checkbox', { name: 'me@gmail.com' })
    const reconnect = screen.getByRole('button', { name: 'Reconnect me@gmail.com' })
    expect(toggle.contains(reconnect)).toBe(false)

    await act(async () => user.tab())
    expect(document.activeElement).toBe(toggle)
    await act(async () => user.keyboard(' '))
    expect(onToggle).toHaveBeenCalledTimes(1)

    await act(async () => user.tab())
    expect(document.activeElement).toBe(reconnect)
    await act(async () => user.keyboard('{Enter}'))
    expect(onReconnect).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})

describe('giving an agent an account signed in for it', () => {
  const bot: { id: string; hostId: 'local'; google: boolean; googleAccounts?: string[] } = {
    id: 'scout',
    hostId: 'local',
    google: true,
    googleAccounts: ['me@work.com']
  }

  it('says so and reports false when adding it to the list fails', async () => {
    setBotGoogle.mockRejectedValueOnce(new Error('Host unreachable'))
    await expect(giveBotGoogleAccount(bot, 'me@gmail.com', vi.fn())).resolves.toBe(false)
    expect(setBotGoogle).toHaveBeenCalledWith(bot, true, {
      accounts: ['me@work.com', 'me@gmail.com']
    })
    expect(toastError).toHaveBeenCalledTimes(1)
  })

  it('turns Google on with only that account for an agent without it', async () => {
    const turnOn = vi.fn(async () => true)
    const off = { ...bot, google: false, googleAccounts: undefined }
    await expect(giveBotGoogleAccount(off, 'me@gmail.com', turnOn)).resolves.toBe(true)
    expect(turnOn).toHaveBeenCalledWith(off, ['me@gmail.com'])
    expect(setBotGoogle).not.toHaveBeenCalled()
  })
})
