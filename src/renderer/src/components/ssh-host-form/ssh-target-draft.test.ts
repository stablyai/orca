import { describe, expect, it } from 'vitest'
import {
  EMPTY_FORM,
  applyParsedSshHostInput,
  getEditingTargetForSshTarget,
  getSshTargetDraftConnectionFields,
  parseSshHostInput
} from './ssh-target-draft'

describe('parseSshHostInput', () => {
  it('normalizes bracketed IPv6 hosts from ssh URLs', () => {
    expect(parseSshHostInput('ssh://deploy@[::1]:2202/srv/app')).toEqual({
      host: '::1',
      username: 'deploy',
      port: 2202,
      configHost: '::1'
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
})

describe('applyParsedSshHostInput', () => {
  it('dials the corrected Host after the first blur copied an implicit configHost', () => {
    const blurred = applyParsedSshHostInput({
      ...EMPTY_FORM,
      host: 'host-a.example'
    })
    const corrected = applyParsedSshHostInput({
      ...blurred,
      host: 'host-b.example'
    })

    expect(getSshTargetDraftConnectionFields(corrected)).toMatchObject({
      host: 'host-b.example',
      configHost: 'host-b.example'
    })
  })

  it('keeps an explicit SSH config alias when Host is blurred again', () => {
    const normalized = applyParsedSshHostInput({
      ...EMPTY_FORM,
      host: 'other.internal',
      configHost: 'prod'
    })

    expect(getSshTargetDraftConnectionFields(normalized)).toMatchObject({
      host: 'other.internal',
      configHost: 'prod'
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
