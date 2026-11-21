import { expect, it } from 'vitest'
import { validateCustomCloudServer } from './custom-cloud-server'

it('accepts auth origins and rejects auth path prefixes', () => {
  const settings = {
    enabled: true,
    authServerUrl: 'https://auth.example.test/',
    clientId: 'desktop',
    relayDirectorUrl: 'https://relay.example.test/'
  }
  expect(validateCustomCloudServer(settings, false)).toEqual({
    enabled: true,
    authServerUrl: 'https://auth.example.test',
    clientId: 'desktop',
    relayDirectorUrl: 'https://relay.example.test'
  })
  expect(
    validateCustomCloudServer(
      { ...settings, authServerUrl: 'https://auth.example.test/orca-auth' },
      false
    )
  ).toBeNull()
})
