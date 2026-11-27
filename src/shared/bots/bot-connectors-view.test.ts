import { describe, expect, it } from 'vitest'
import type { GoogleDefaultRead } from '../google/google-bot-accounts'
import type { GoogleAccountView } from '../google/google-connect-types'
import { botConnectorServices } from './bot-connectors-view'

const account = (email: string): GoogleAccountView => ({
  email,
  status: 'connected',
  services: [{ service: 'gmail', state: 'ready' }],
  connectedAt: 0
})

function googleRow(
  googleAccounts?: string[],
  hostEmails = ['Me@Work.com', 'me@gmail.com'],
  googleDefault: GoogleDefaultRead = { email: 'me@work.com' }
) {
  const services = botConnectorServices(
    { slack: null, linear: null, github: null, google: true, googleAccounts },
    {
      gh: 'signed-in',
      linear: false,
      google: hostEmails.map(account),
      googleApp: true,
      googleDefault
    }
  )
  return services.find((service) => service.source === 'google')
}
const googleDetail = (googleAccounts?: string[]) => googleRow(googleAccounts)?.detail

describe('orca bot connectors, Google', () => {
  it('lists only the accounts the bot may use, with its own default', () => {
    expect(googleDetail(['me@gmail.com'])).toBe('me@gmail.com (default): Gmail ready')
    // The host's email case doesn't hide which is the default.
    expect(googleDetail()).toBe('Me@Work.com (default): Gmail ready; me@gmail.com: Gmail ready')
  })

  it('says none of its accounts is here, not that nobody is signed in', () => {
    expect(googleRow(['gone@x.com'])?.gap).toContain(
      'None of the Google accounts on this computer is chosen for you'
    )
  })

  it('marks no default when the computer’s is unreadable and several are chosen', () => {
    const detail = googleRow(['me@work.com', 'me@gmail.com'], undefined, {
      unreadable: 'Keychain denied.'
    })?.detail
    expect(detail).toBe('Me@Work.com: Gmail ready; me@gmail.com: Gmail ready')
  })
})
