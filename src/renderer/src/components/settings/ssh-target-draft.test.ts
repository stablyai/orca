import { describe, expect, it } from 'vitest'
import {
  EMPTY_FORM,
  applyParsedSshHostInput,
  getSshTargetDraftConnectionFields,
  parseSshHostInput
} from './ssh-target-draft'

describe('parseSshHostInput', () => {
  it('parses scp-style user, host, and port input', () => {
    expect(parseSshHostInput('deploy@example.com:2202')).toEqual({
      host: 'example.com',
      username: 'deploy',
      port: 2202,
      configHost: 'example.com'
    })
  })

  it('parses ssh URLs', () => {
    expect(parseSshHostInput('ssh://deploy@example.com:2202/srv/app')).toEqual({
      host: 'example.com',
      username: 'deploy',
      port: 2202,
      configHost: 'example.com'
    })
  })

  it('keeps plain OpenSSH config aliases valid without a username', () => {
    expect(parseSshHostInput('prod-box')).toEqual({
      host: 'prod-box',
      username: undefined,
      port: undefined,
      configHost: 'prod-box'
    })
  })
})

describe('applyParsedSshHostInput', () => {
  it('fills empty username and default port from pasted input', () => {
    expect(
      applyParsedSshHostInput({ ...EMPTY_FORM, host: 'deploy@example.com:2202' })
    ).toMatchObject({
      host: 'example.com',
      configHost: 'example.com',
      username: 'deploy',
      port: '2202'
    })
  })

  it('does not overwrite explicit username or non-default port', () => {
    expect(
      applyParsedSshHostInput({
        ...EMPTY_FORM,
        host: 'deploy@example.com:2202',
        username: 'root',
        port: '2022'
      })
    ).toMatchObject({
      host: 'example.com',
      username: 'root',
      port: '2022'
    })
  })
})

describe('getSshTargetDraftConnectionFields', () => {
  it('uses pasted user and port when the dedicated fields are still default', () => {
    expect(
      getSshTargetDraftConnectionFields({ ...EMPTY_FORM, host: 'deploy@example.com:2202' })
    ).toEqual({
      host: 'example.com',
      configHost: 'example.com',
      username: 'deploy',
      port: 2202
    })
  })

  it('allows config aliases without a username', () => {
    expect(getSshTargetDraftConnectionFields({ ...EMPTY_FORM, host: 'prod-box' })).toEqual({
      host: 'prod-box',
      configHost: 'prod-box',
      username: '',
      port: 22
    })
  })
})
