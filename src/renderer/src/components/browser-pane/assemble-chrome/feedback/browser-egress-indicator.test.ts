import { describe, expect, it } from 'vitest'
import { translate } from '@/i18n/i18n'
import { remoteRuntimeEgressCopy } from './browser-egress-indicator'

const copy = (viewer: 'own-computer' | 'teammate' | 'unknown') =>
  remoteRuntimeEgressCopy(translate, { presentation: 'client-hosted', viewer, hostLabel: 'Mac' })

describe('client-hosted remote egress copy', () => {
  it('tells a teammate that only localhost goes through the shared host', () => {
    expect(copy('teammate')).toEqual({
      description: 'Browsing localhost through Mac',
      detail:
        'The page renders on this device. Localhost pages go through the shared host; other sites load from your network.'
    })
  })

  it('keeps the through-the-host copy for the owner’s own computers', () => {
    expect(copy('own-computer')).toEqual({
      description: 'Browsing through Mac',
      detail: 'The page renders on this device. Network traffic and DNS go through the remote host.'
    })
  })

  it('claims no route while the viewer is unknown', () => {
    expect(copy('unknown')).toBeNull()
  })
})
