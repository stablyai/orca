import { describe, expect, it } from 'vitest'
import { EMPTY_FORM } from './ssh-target-draft'
import { buildSshTargetSavePayload } from './ssh-target-save-payload'

describe('buildSshTargetSavePayload', () => {
  it('rejects empty hosts', () => {
    const result = buildSshTargetSavePayload({ ...EMPTY_FORM, host: '' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('Host or SSH config alias is required')
    }
  })

  it('omits default SSH connection reuse from new targets but clears it on update', () => {
    const result = buildSshTargetSavePayload({
      ...EMPTY_FORM,
      label: 'Production',
      host: 'prod.example.com',
      username: 'deploy',
      port: '2202'
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.payload.target).toMatchObject({
      label: 'Production',
      configHost: 'prod.example.com',
      host: 'prod.example.com',
      port: 2202,
      username: 'deploy',
      relayGracePeriodSeconds: 0
    })
    expect(result.payload.target).not.toHaveProperty('systemSshConnectionReuse')
    expect(result.payload.updates).toMatchObject({
      source: 'manual',
      identityFile: undefined,
      proxyCommand: undefined,
      jumpHost: undefined,
      systemSshConnectionReuse: undefined
    })
  })

  it('persists explicit SSH connection reuse opt-outs and bounded relay timeouts', () => {
    const result = buildSshTargetSavePayload({
      ...EMPTY_FORM,
      host: 'appliance.example.com',
      username: 'admin',
      identityFile: '~/.ssh/appliance',
      proxyCommand: 'cloudflared access ssh --hostname %h',
      jumpHost: 'bastion.example.com',
      systemSshConnectionReuse: false,
      relayKeepAliveUntilReset: false,
      relayGracePeriodSeconds: '600'
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.payload.target).toMatchObject({
      label: 'admin@appliance.example.com',
      host: 'appliance.example.com',
      relayGracePeriodSeconds: 600,
      identityFile: '~/.ssh/appliance',
      proxyCommand: 'cloudflared access ssh --hostname %h',
      jumpHost: 'bastion.example.com',
      systemSshConnectionReuse: false
    })
    expect(result.payload.updates).toMatchObject({
      source: 'manual',
      systemSshConnectionReuse: false
    })
  })

  it('stores the runtime choice, and Auto stores nothing so the default can move', () => {
    const pinned = buildSshTargetSavePayload({
      ...EMPTY_FORM,
      host: 'old.example.com',
      remoteRuntime: 'pinned-node'
    })
    const auto = buildSshTargetSavePayload({ ...EMPTY_FORM, host: 'old.example.com' })
    if (!pinned.ok || !auto.ok) {
      throw new Error('expected valid payloads')
    }
    expect(pinned.payload.target.remoteRuntime).toBe('pinned-node')
    expect(pinned.payload.updates.remoteRuntime).toBe('pinned-node')
    expect(auto.payload.target).not.toHaveProperty('remoteRuntime')
    // Why explicit undefined: updateTarget merges, so Auto must clear an earlier choice.
    expect(auto.payload.updates).toHaveProperty('remoteRuntime', undefined)
  })

  it('rejects invalid bounded relay timeouts', () => {
    const result = buildSshTargetSavePayload({
      ...EMPTY_FORM,
      host: 'appliance.example.com',
      relayKeepAliveUntilReset: false,
      relayGracePeriodSeconds: '59'
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('Terminal timeout')
    }
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

  it('omits an unchanged proxy from updates so a sealed proxy survives unrelated saves', () => {
    // Why the '' baseline: that is what listTargets() actually returns — the store
    // persists '' for a target that never had a proxy, and a keychain-sealed proxy
    // also reads back as ''. A baseline of undefined would not reproduce the bug.
    const result = buildSshTargetSavePayload(
      { ...EMPTY_FORM, host: 'appliance.example.com', label: 'Renamed' },
      { httpProxyUrl: '', httpProxyBypassRules: '' }
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.payload.updates).not.toHaveProperty('httpProxyUrl')
    expect(result.payload.updates).not.toHaveProperty('httpProxyBypassRules')
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

  it('does not re-send an unchanged configured proxy', () => {
    const result = buildSshTargetSavePayload(
      {
        ...EMPTY_FORM,
        host: 'appliance.example.com',
        httpProxyUrl: 'http://proxy.lan:3128',
        httpProxyBypassRules: 'localhost'
      },
      { httpProxyUrl: 'http://proxy.lan:3128', httpProxyBypassRules: 'localhost' }
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.payload.target.httpProxyUrl).toBe('http://proxy.lan:3128')
    expect(result.payload.updates).not.toHaveProperty('httpProxyUrl')
    expect(result.payload.updates).not.toHaveProperty('httpProxyBypassRules')
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
