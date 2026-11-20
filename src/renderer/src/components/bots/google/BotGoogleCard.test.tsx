// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import { ConfirmationDialogContext } from '@/components/dismiss/confirmation/confirmation-dialog-context'

const mocks = vi.hoisted(() => {
  const host: { current: object } = { current: { status: 'loading' } }
  return { setBotGoogle: vi.fn(), confirm: vi.fn(), host }
})
vi.mock('./google-connect-client', () => ({
  setBotGoogle: mocks.setBotGoogle,
  useGoogleHost: () => mocks.host.current
}))
vi.mock('./setup-cards/google-setup-run-store', () => ({ startGoogleSetupInChat: vi.fn() }))

import { BotGoogleCard } from './BotGoogleCard'
import { useTurnOnBotGoogle } from './use-turn-on-bot-google'

const bot: Pick<Bot, 'id' | 'name' | 'members' | 'hostId'> = {
  id: 'b1',
  hostId: 'local',
  name: 'Scout',
  members: []
}

function mountTurnOn() {
  const { result } = renderHook(() => useTurnOnBotGoogle(), {
    wrapper: ({ children }) => (
      <ConfirmationDialogContext.Provider value={mocks.confirm}>
        {children}
      </ConfirmationDialogContext.Provider>
    )
  })
  return result.current
}

beforeEach(() => {
  mocks.setBotGoogle.mockReset().mockResolvedValue(undefined)
  mocks.confirm.mockReset()
  mocks.host.current = {
    status: 'ready',
    google: {
      client: null,
      bots: [],
      accounts: [{ email: 'a@x.com', status: 'connected', connectedAt: 1, services: [] }]
    }
  }
})
afterEach(cleanup)

function renderConnectedRow(): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row reads only id, name, members and google.
  const row = { ...bot, google: true } as Bot
  render(
    <ConfirmationDialogContext.Provider value={mocks.confirm}>
      <BotGoogleCard bot={row} />
    </ConfirmationDialogContext.Provider>
  )
}

describe('the Google row in a bot’s connectors', () => {
  it('removes Google from the bot after a confirm, like other connectors', async () => {
    mocks.confirm.mockResolvedValue(true)
    renderConnectedRow()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Google actions' }), {
      button: 0,
      ctrlKey: false
    })
    await act(async () => {
      fireEvent.click(await screen.findByRole('menuitem', { name: /Remove Google/ }))
    })
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Remove Google from Scout?' })
    )
    expect(mocks.setBotGoogle).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1' }), false)
  })
})

describe('turning Google on for a bot', () => {
  it('reports a refused write and lets the owner retry without confirmation', async () => {
    const turnOn = mountTurnOn()
    mocks.setBotGoogle.mockRejectedValueOnce(new Error('no account'))
    await expect(turnOn(bot)).resolves.toBe(false)
    await expect(turnOn(bot)).resolves.toBe(true)
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.setBotGoogle.mock.calls).toEqual([
      [expect.objectContaining({ id: 'b1' }), true],
      [expect.objectContaining({ id: 'b1' }), true]
    ])
  })

  it('names who else can then use the owner’s Google, and stays off when declined', async () => {
    mocks.confirm.mockResolvedValue(false)
    const shared = { ...bot, members: [{ id: 'U1', name: 'Bob', source: 'slack' }] }
    const turnOn = mountTurnOn()
    await expect(turnOn(shared)).resolves.toBe(false)
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'security',
        description: 'Bob will be able to have Scout read and send your email, calendar and files.'
      })
    )
    expect(mocks.setBotGoogle).not.toHaveBeenCalled()
  })
})
