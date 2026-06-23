import { describe, expect, it } from 'vitest'
import {
  EMPTY_FORM,
  applyParsedSshHostInput,
  getEditingTargetForSshTarget,
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

  it('normalizes bracketed IPv6 hosts from ssh URLs', () => {
    expect(parseSshHostInput('ssh://deploy@[::1]:2202/srv/app')).toEqual({
      host: '::1',
      username: 'deploy',
      port: 2202,
      configHost: '::1'
    })
  })

  it('marks invalid pasted host ports instead of keeping them in the hostname', () => {
    expect(parseSshHostInput('deploy@example.com:99999')).toEqual({
      host: 'example.com',
      username: 'deploy',
      port: undefined,
      invalidPort: true,
      configHost: 'example.com'
    })
    expect(parseSshHostInput('[::1]:0')).toEqual({
      host: '::1',
      username: undefined,
      port: undefined,
      invalidPort: true,
      configHost: '::1'
    })
  })

  it('marks invalid ssh URL ports instead of keeping the raw URL as the hostname', () => {
    expect(parseSshHostInput('ssh://deploy@example.com:99999/srv/app')).toEqual({
      host: 'example.com',
      username: 'deploy',
      port: undefined,
      invalidPort: true,
      configHost: 'example.com'
    })
  })

  it('does not throw on malformed username escapes in invalid ssh URL ports', () => {
    expect(parseSshHostInput('ssh://bad%ZZ@example.com:99999/srv/app')).toEqual({
      host: 'example.com',
      username: 'bad%ZZ',
      port: undefined,
      invalidPort: true,
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

  it('keeps invalid pasted ports visible for correction', () => {
    expect(applyParsedSshHostInput({ ...EMPTY_FORM, host: 'deploy@example.com:99999' })).toEqual({
      ...EMPTY_FORM,
      host: 'deploy@example.com:99999'
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

  it('surfaces invalid pasted ports to the form validator', () => {
    const fields = getSshTargetDraftConnectionFields({
      ...EMPTY_FORM,
      host: 'deploy@example.com:99999'
    })

    expect(fields).toMatchObject({
      host: 'example.com',
      configHost: 'example.com',
      username: 'deploy'
    })
    expect(Number.isNaN(fields.port)).toBe(true)
  })
})

describe('getEditingTargetForSshTarget', () => {
  it('recomputes implicit configHost when a manual target host is edited', () => {
    const draft = getEditingTargetForSshTarget({
      id: 'ssh-1',
      label: 'Server',
      configHost: 'old.example.com',
      host: 'old.example.com',
      port: 22,
      username: ''
    })

    expect(
      getSshTargetDraftConnectionFields({
        ...draft,
        host: 'new.example.com'
      })
    ).toEqual({
      host: 'new.example.com',
      configHost: 'new.example.com',
      username: '',
      port: 22
    })
  })

  it('preserves explicit SSH config aliases when editing imported targets', () => {
    const draft = getEditingTargetForSshTarget({
      id: 'ssh-1',
      label: 'Production',
      configHost: 'prod',
      host: 'prod.internal',
      port: 22,
      username: 'deploy'
    })

    expect(draft.configHost).toBe('prod')
    expect(getSshTargetDraftConnectionFields(draft)).toEqual({
      host: 'prod.internal',
      configHost: 'prod',
      username: 'deploy',
      port: 22
    })
  })
})
