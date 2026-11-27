import { describe, expect, it } from 'vitest'
import type { GoogleAccountView } from './google-connect-types'
import { botGoogleConnectState, botGoogleSettingUp } from './google-bot-connect-state'

const account = (email: string, status: GoogleAccountView['status']): GoogleAccountView => ({
  email,
  status,
  services: [{ service: 'gmail', state: 'ready' }],
  connectedAt: 1
})

describe('a bot’s Google row status', () => {
  it('is Setting up only while a running setup has not yet made the bot’s Google work', () => {
    const running = { state: 'running' as const }
    const host = {
      client: { clientId: 'app' },
      accounts: [account('me@gmail.com', 'connected'), account('me@work.com', 'reconnect')]
    }
    // A setup left running after Google was signed in some other way: the CLI says Signed in.
    expect(botGoogleSettingUp(botGoogleConnectState({ google: true }, host), running)).toBe(false)
    // Only its signed-out account is chosen for the bot: still being set up for it.
    const limited = botGoogleConnectState({ google: true, googleAccounts: ['me@work.com'] }, host)
    expect(botGoogleSettingUp(limited, running)).toBe(true)
    const nobody = botGoogleConnectState({ google: true }, { client: null, accounts: [] })
    expect(botGoogleSettingUp(nobody, running)).toBe(true)
    expect(botGoogleSettingUp(nobody, { state: 'cancelled' })).toBe(false)
  })
})
