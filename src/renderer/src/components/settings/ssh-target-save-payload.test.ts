import { describe, expect, it } from 'vitest'
import {
  EMPTY_FORM,
  getEditingTargetForSshTarget,
  hasAdvancedConnectionValues,
  isSshTargetFormDirty
} from './ssh-target-draft'
import { buildSshTargetSavePayload } from './ssh-target-save-payload'

describe('buildSshTargetSavePayload', () => {
  it('rejects empty hosts', () => {
    const result = buildSshTargetSavePayload({ ...EMPTY_FORM, host: '' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('Host or SSH config alias is required')
    }
  })

  it('saves remote CLI control on by default and an explicit false when turned off', () => {
    const on = buildSshTargetSavePayload({ ...EMPTY_FORM, host: 'gpu.example.com' })
    const off = buildSshTargetSavePayload({
      ...EMPTY_FORM,
      host: 'gpu.example.com',
      allowRemoteCliControl: false
    })
    if (!off.ok || !on.ok) {
      throw new Error('payload rejected')
    }
    expect(on.payload.target).toMatchObject({ allowRemoteCliControl: true })
    expect(on.payload.updates).toMatchObject({ allowRemoteCliControl: true })
    expect(off.payload.target).toMatchObject({ allowRemoteCliControl: false })
    expect(off.payload.updates).toMatchObject({ allowRemoteCliControl: false })
    expect(hasAdvancedConnectionValues(EMPTY_FORM)).toBe(false)
    expect(hasAdvancedConnectionValues({ ...EMPTY_FORM, allowRemoteCliControl: false })).toBe(true)
  })

  it('shows a host with no saved value as on, and an explicit false as off', () => {
    const host = { id: 'gpu', label: 'gpu', host: 'gpu.example.com', port: 22, username: 'me' }
    expect(getEditingTargetForSshTarget(host).allowRemoteCliControl).toBe(true)
    expect(
      getEditingTargetForSshTarget({ ...host, allowRemoteCliControl: false }).allowRemoteCliControl
    ).toBe(false)
  })

  it('round-trips the remote CLI control opt-in through the edit form', () => {
    const form = getEditingTargetForSshTarget({
      id: 'gpu',
      label: 'gpu',
      host: 'gpu.example.com',
      port: 22,
      username: 'me',
      allowRemoteCliControl: true
    })
    expect(form.allowRemoteCliControl).toBe(true)
    expect(isSshTargetFormDirty({ ...form, allowRemoteCliControl: false }, form)).toBe(true)
  })

  it('persists a per-host HTTP proxy with normalized URL and bypass rules', () => {
    const result = buildSshTargetSavePayload({
      ...EMPTY_FORM,
      host: 'appliance.example.com',
      httpProxyUrl: ' http://proxy.lan:3128 ',
      httpProxyBypassRules: 'localhost;*.internal\n10.0.0.1'
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.payload.target.httpProxyUrl).toBe('http://proxy.lan:3128')
    expect(result.payload.target.httpProxyBypassRules).toBe('localhost;*.internal;10.0.0.1')
    expect(result.payload.updates.httpProxyBypassRules).toBe('localhost;*.internal;10.0.0.1')
  })

  it('rejects a malformed per-host proxy URL instead of persisting it', () => {
    const result = buildSshTargetSavePayload({
      ...EMPTY_FORM,
      host: 'appliance.example.com',
      httpProxyUrl: 'not a url'
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('valid proxy')
    }
  })

  it('sends no proxy keys for a brand-new target that has no proxy', () => {
    // Why: with no saved target there is nothing to clear, so an update must not claim
    // an explicit clear; the create input is where a new host's proxy travels.
    const result = buildSshTargetSavePayload({ ...EMPTY_FORM, host: 'appliance.example.com' })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.payload.target).not.toHaveProperty('httpProxyUrl')
    expect(result.payload.updates).not.toHaveProperty('httpProxyUrl')
    expect(result.payload.updates).not.toHaveProperty('httpProxyBypassRules')
  })

  it('omits unchanged proxy fields so an untouched saved proxy is never read as a clear', () => {
    // The '' baseline is what listTargets() returns: the store persists '' for a target
    // that never had a proxy, and a keychain-sealed proxy reads back as '' too.
    const unchanged = [
      buildSshTargetSavePayload(
        { ...EMPTY_FORM, host: 'appliance.example.com', label: 'Renamed' },
        { httpProxyUrl: '', httpProxyBypassRules: '' }
      ),
      buildSshTargetSavePayload(
        {
          ...EMPTY_FORM,
          host: 'appliance.example.com',
          label: 'Renamed',
          httpProxyUrl: 'http://proxy.lan:3128',
          httpProxyBypassRules: 'localhost'
        },
        { httpProxyUrl: 'http://proxy.lan:3128', httpProxyBypassRules: 'localhost' }
      )
    ]

    for (const result of unchanged) {
      expect(result.ok).toBe(true)
      if (!result.ok) {
        throw new Error(result.error)
      }
      expect(result.payload.updates).not.toHaveProperty('httpProxyUrl')
      expect(result.payload.updates).not.toHaveProperty('httpProxyBypassRules')
    }
  })

  it('ships only the bypass rules when a sealed proxy URL is left untouched', () => {
    // Why: sending httpProxyUrl: undefined alongside a bypass edit would read as an
    // explicit clear at persistence and release the sealed proxy.
    const result = buildSshTargetSavePayload(
      {
        ...EMPTY_FORM,
        host: 'appliance.example.com',
        httpProxyBypassRules: 'localhost;*.internal'
      },
      { httpProxyUrl: '', httpProxyBypassRules: '' }
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.payload.updates).not.toHaveProperty('httpProxyUrl')
    expect(result.payload.updates.httpProxyBypassRules).toBe('localhost;*.internal')
  })

  it('sends an explicit clear when the user removes a previously configured proxy', () => {
    const result = buildSshTargetSavePayload(
      { ...EMPTY_FORM, host: 'appliance.example.com' },
      { httpProxyUrl: 'http://proxy.lan:3128', httpProxyBypassRules: 'localhost' }
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.payload.updates).toHaveProperty('httpProxyUrl', undefined)
    expect(result.payload.updates).toHaveProperty('httpProxyBypassRules', undefined)
  })

  it('sends the proxy when the user edits it', () => {
    const result = buildSshTargetSavePayload(
      { ...EMPTY_FORM, host: 'appliance.example.com', httpProxyUrl: 'http://proxy.lan:3129' },
      { httpProxyUrl: 'http://proxy.lan:3128', httpProxyBypassRules: undefined }
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.payload.updates.httpProxyUrl).toBe('http://proxy.lan:3129')
  })
})
