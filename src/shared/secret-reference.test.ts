import { describe, expect, it } from 'vitest'
import {
  classifyAgentEnvSecretReferences,
  isSecretReferenceCandidate,
  validateSecretReference
} from './secret-reference'

const POSTHOG_REFERENCE = 'doppler-ref://lets-tango/dev_ops/POSTHOG_READ_ONLY'

describe('secret reference validation', () => {
  it('parses approved references and classifies their destination keys', () => {
    expect(validateSecretReference('POSTHOG_READ_ONLY', POSTHOG_REFERENCE)).toEqual({
      ok: true,
      reference: {
        project: 'lets-tango',
        config: 'dev_ops',
        name: 'POSTHOG_READ_ONLY'
      }
    })
    expect(
      classifyAgentEnvSecretReferences({
        PATH: '/usr/bin',
        POSTHOG_READ_ONLY: POSTHOG_REFERENCE,
        LINEAR_API_KEY: 'doppler-ref://lets-tango/dev_ops/LINEAR_API_KEY'
      })
    ).toEqual({
      kind: 'valid',
      entries: [
        {
          key: 'POSTHOG_READ_ONLY',
          reference: {
            project: 'lets-tango',
            config: 'dev_ops',
            name: 'POSTHOG_READ_ONLY'
          }
        },
        {
          key: 'LINEAR_API_KEY',
          reference: {
            project: 'lets-tango',
            config: 'dev_ops',
            name: 'LINEAR_API_KEY'
          }
        }
      ]
    })
  })

  it.each([
    'doppler-ref:',
    'doppler-ref://',
    'doppler-ref://lets-tango/dev_ops',
    'doppler-ref://lets-tango//POSTHOG_READ_ONLY',
    'doppler-ref://lets-tango/dev_ops/POSTHOG_READ_ONLY/extra',
    'doppler-ref://lets tango/dev_ops/POSTHOG_READ_ONLY',
    'doppler-ref://lets-tango/dev_ops/POSTHOG_READ_ONLY\n',
    'doppler-ref://lets-tango/dev_ops/POSTHOG_READ_ONLY?raw=true',
    'doppler-ref://lets-tango/dev_ops/POSTHOG_READ_ONLY#value'
  ])('fails closed for malformed candidate %s', (value) => {
    expect(isSecretReferenceCandidate(value)).toBe(true)
    expect(validateSecretReference('POSTHOG_READ_ONLY', value)).toEqual({
      ok: false,
      code: 'malformed'
    })
  })

  it('rejects destination mismatches and names outside the allowlist', () => {
    expect(validateSecretReference('LINEAR_API_KEY', POSTHOG_REFERENCE)).toEqual({
      ok: false,
      code: 'key-name-mismatch'
    })
    expect(validateSecretReference('HOME', 'doppler-ref://lets-tango/dev_ops/HOME')).toEqual({
      ok: false,
      code: 'name-not-approved'
    })
    expect(
      validateSecretReference('CODEX_HOME', 'doppler-ref://lets-tango/dev_ops/CODEX_HOME')
    ).toEqual({ ok: false, code: 'name-not-approved' })
  })

  it('ignores ordinary values and reports every invalid candidate key', () => {
    expect(classifyAgentEnvSecretReferences({ PATH: '/usr/bin' })).toEqual({ kind: 'none' })
    expect(
      classifyAgentEnvSecretReferences({
        POSTHOG_READ_ONLY: 'doppler-ref://lets-tango/dev_ops/POSTHOG_READ_ONLY?raw=true',
        HOME: 'doppler-ref://lets-tango/dev_ops/HOME',
        PATH: '/usr/bin'
      })
    ).toEqual({ kind: 'invalid', keys: ['POSTHOG_READ_ONLY', 'HOME'] })
  })
})
