import { expect, it } from 'vitest'
import { reasonixConfigRoots } from './reasonix-config-roots'

it('keeps native config and state overrides distinct and refuses relative overrides', () => {
  expect(reasonixConfigRoots('/host', 'linux', {})).toEqual({
    configHome: '/host/.reasonix',
    stateHome: '/host/.reasonix'
  })
  expect(
    reasonixConfigRoots('/host', 'linux', {
      REASONIX_HOME: '/config',
      REASONIX_STATE_HOME: '/state'
    })
  ).toEqual({ configHome: '/config', stateHome: '/state' })
  expect(
    reasonixConfigRoots('/host', 'linux', {
      REASONIX_HOME: '../other',
      REASONIX_STATE_HOME: 'state'
    })
  ).toEqual({ configHome: '/host/.reasonix', stateHome: '/host/.reasonix' })
  expect(reasonixConfigRoots('C:\\Users\\host', 'win32', { APPDATA: 'C:\\Roaming' })).toEqual({
    configHome: 'C:\\Roaming\\reasonix',
    stateHome: 'C:\\Roaming\\reasonix'
  })
})

it('expands the native tilde and braced variables using only the owning host environment', () => {
  expect(
    reasonixConfigRoots('/host', 'linux', {
      REASONIX_HOME: '~/.custom',
      REASONIX_STATE_HOME: '${STORE:-/fallback}/state',
      STORE: '/native-host'
    })
  ).toEqual({ configHome: '/host/.custom', stateHome: '/native-host/state' })
  expect(
    reasonixConfigRoots('C:\\Users\\host', 'win32', {
      REASONIX_HOME: '~\\config',
      REASONIX_STATE_HOME: '${EMPTY:-C:\\history}',
      EMPTY: ''
    })
  ).toEqual({ configHome: 'C:\\Users\\host\\config', stateHome: 'C:\\history' })
})

it('keeps native non-recursive expansion and does not interpret bare variables or Windows percent syntax', () => {
  expect(
    reasonixConfigRoots('/host', 'linux', {
      REASONIX_HOME: '${MISSING}',
      REASONIX_STATE_HOME: '${NESTED}',
      NESTED: '${STORE}',
      STORE: '/unrelated'
    })
  ).toEqual({ configHome: '/host/.reasonix', stateHome: '/host/.reasonix' })
  expect(
    reasonixConfigRoots('/host', 'linux', {
      REASONIX_HOME: '$STORE/config',
      REASONIX_STATE_HOME: '%STORE%/state',
      STORE: '/unrelated'
    })
  ).toEqual({ configHome: '/host/.reasonix', stateHome: '/host/.reasonix' })
})
