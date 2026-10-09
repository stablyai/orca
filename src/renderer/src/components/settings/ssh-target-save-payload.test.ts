import { describe, expect, it } from 'vitest'
import { EMPTY_FORM, getEditingTargetForSshTarget, isSshTargetFormDirty } from './ssh-target-draft'
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

  it('keeps remote CLI control off unless the user opts this host in, and clears it on update', () => {
    const off = buildSshTargetSavePayload({ ...EMPTY_FORM, host: 'gpu.example.com' })
    const on = buildSshTargetSavePayload({
      ...EMPTY_FORM,
      host: 'gpu.example.com',
      allowRemoteCliControl: true
    })
    if (!off.ok || !on.ok) {
      throw new Error('payload rejected')
    }
    expect(off.payload.target).not.toHaveProperty('allowRemoteCliControl')
    expect(off.payload.updates).toHaveProperty('allowRemoteCliControl', undefined)
    expect(on.payload.target).toMatchObject({ allowRemoteCliControl: true })
    expect(on.payload.updates).toMatchObject({ allowRemoteCliControl: true })
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
})
