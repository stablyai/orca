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

  it('persists zmx terminal ownership and clears it when disabled', () => {
    const enabled = buildSshTargetSavePayload({
      ...EMPTY_FORM,
      host: 'durable.example.com',
      zmxTerminalPersistence: true
    })
    expect(enabled.ok).toBe(true)
    if (enabled.ok) {
      expect(enabled.payload.target.terminalPersistenceBackend).toBe('zmx')
      expect(enabled.payload.updates.terminalPersistenceBackend).toBe('zmx')
    }

    const disabled = buildSshTargetSavePayload({
      ...EMPTY_FORM,
      host: 'durable.example.com'
    })
    expect(disabled.ok).toBe(true)
    if (disabled.ok) {
      expect(disabled.payload.target).not.toHaveProperty('terminalPersistenceBackend')
      expect(disabled.payload.updates).toHaveProperty('terminalPersistenceBackend', undefined)
    }
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
})
