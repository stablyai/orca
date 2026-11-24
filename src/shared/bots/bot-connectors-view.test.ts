import { describe, expect, it } from 'vitest'
import type { GoogleAccountView } from '../google/google-connect-types'
import { botConnectorServices } from './bot-connectors-view'

const account = (email: string): GoogleAccountView => ({
  email,
  status: 'connected',
  services: [{ service: 'gmail', state: 'ready' }],
  connectedAt: 0
})

function googleDetail(googleAccounts?: string[]): string | undefined {
  const services = botConnectorServices(
    { slack: null, linear: null, github: null, google: true, googleAccounts },
    {
      gh: 'signed-in',
      linear: false,
      google: [account('me@work.com'), account('me@gmail.com')],
      googleApp: true,
      googleDefault: 'me@work.com'
    }
  )
  return services.find((service) => service.source === 'google')?.detail
}

describe('orca bot connectors, Google', () => {
  it('lists only the accounts the bot may use, with its own default', () => {
    expect(googleDetail(['me@gmail.com'])).toBe('me@gmail.com (default): Gmail ready')
    expect(googleDetail()).toBe('me@work.com (default): Gmail ready; me@gmail.com: Gmail ready')
  })
})
