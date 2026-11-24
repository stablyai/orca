// @vitest-environment happy-dom
import { act } from 'react'
import { cleanup, render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GoogleAccountPickerRow } from './GoogleAccountPicker'
import { giveBotGoogleAccount } from './give-bot-google-account'
import { useTurnOnBotGoogle } from './use-turn-on-bot-google'
import { ConfirmationDialogProvider } from '@/components/dismiss/confirmation/confirmation-dialog'

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
    await expect(giveBotGoogleAccount(bot, 'me@gmail.com', vi.fn(), async (b) => b)).resolves.toBe(
      false
    )
    expect(setBotGoogle).toHaveBeenCalledWith(bot, true, {
      accounts: ['me@work.com', 'me@gmail.com']
    })
    expect(toastError).toHaveBeenCalledTimes(1)
  })

  it('turns Google on with only that account for an agent without it', async () => {
    const turnOn = vi.fn(async () => true)
    const off = { ...bot, google: false, googleAccounts: undefined }
    await expect(giveBotGoogleAccount(off, 'me@gmail.com', turnOn, async (b) => b)).resolves.toBe(
      true
    )
    expect(turnOn).toHaveBeenCalledWith(off, ['me@gmail.com'])
    expect(setBotGoogle).not.toHaveBeenCalled()
  })
})

describe('granting after a sign-in', () => {
  const stale: { id: string; hostId: 'local'; google: boolean; googleAccounts?: string[] } = {
    id: 'scout',
    hostId: 'local',
    google: true,
    googleAccounts: ['a@x.com']
  }

  it('adds the account to the list the host has now, not the one from before', async () => {
    setBotGoogle.mockResolvedValueOnce(undefined)
    const fresh = { ...stale, googleAccounts: ['c@x.com'] }
    await expect(giveBotGoogleAccount(stale, 'b@x.com', vi.fn(), async () => fresh)).resolves.toBe(
      true
    )
    expect(setBotGoogle).toHaveBeenCalledWith(fresh, true, { accounts: ['c@x.com', 'b@x.com'] })
  })

  it('grants nothing when the host’s current list cannot be confirmed', async () => {
    const turnOn = vi.fn(async () => true)
    const unconfirmed = async (): Promise<typeof stale> => {
      throw new Error('host offline')
    }
    await expect(giveBotGoogleAccount(stale, 'b@x.com', turnOn, unconfirmed)).resolves.toBe(false)
    const off = { ...stale, google: false, googleAccounts: undefined }
    await expect(giveBotGoogleAccount(off, 'b@x.com', turnOn, unconfirmed)).resolves.toBe(false)
    expect(setBotGoogle).not.toHaveBeenCalled()
    expect(turnOn).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledTimes(2)
  })
})

describe('turning Google on for an agent', () => {
  it('sends the askers it was confirmed for, so the host refuses if they changed', async () => {
    const { result } = renderHook(() => useTurnOnBotGoogle(), {
      wrapper: ConfirmationDialogProvider
    })
    const bot = { id: 'scout', name: 'Scout', hostId: 'local' as const, members: [] }
    await act(async () => {
      await expect(result.current(bot, ['me@gmail.com'])).resolves.toBe(true)
    })
    expect(setBotGoogle).toHaveBeenCalledWith(bot, true, {
      accounts: ['me@gmail.com'],
      confirmedAskers: []
    })
  })
})
