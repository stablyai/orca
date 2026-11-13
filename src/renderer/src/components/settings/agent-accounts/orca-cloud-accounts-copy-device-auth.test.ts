// RS-3: the Codex broker's `device_auth_disabled` (ChatGPT won't issue a device code for this account)
// says what to do, never the generic "Couldn't save to your Orca account."
import { describe, expect, it } from 'vitest'
import { translate } from '@/i18n/i18n'
import { setupFailureCopy, setupFailureTone } from './orca-cloud-accounts-copy'

describe('setupFailureCopy: device code sign-in turned off (RS-3)', () => {
  it('names the cause and the fix', () => {
    expect(setupFailureCopy('codex', 'device_auth_disabled', translate)).toEqual({
      title: 'Device code sign-in is off for this ChatGPT account',
      detail:
        'Turn it on in ChatGPT’s security settings, then try again. On a work or team account, a ChatGPT admin may need to turn it on.'
    })
    expect(setupFailureTone('device_auth_disabled')).toBe('warning')
    expect(setupFailureTone('broker_unavailable')).toBe('error')
    expect(setupFailureCopy('codex', 'broker_unavailable', translate).title).toBe(
      'Couldn’t save to your Orca account.'
    )
  })
})
