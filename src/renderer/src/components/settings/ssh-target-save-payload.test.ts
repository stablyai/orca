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

  it('saves despite a hidden invalid grace value while zmx is enabled', () => {
    const result = buildSshTargetSavePayload({
      ...EMPTY_FORM,
      host: 'durable.example.com',
      zmxTerminalPersistence: true,
      relayKeepAliveUntilReset: false,
      relayGracePeriodSeconds: 'not-a-number'
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      // Why: the grace controls are unmounted under zmx; a stale unparsable
      // draft falls back to keep-alive instead of failing an invisible field.
      expect(result.payload.target.relayGracePeriodSeconds).toBe(0)
    }
  })

  it('persists zmx opt-ins and clears the field for relay defaults', () => {
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
      host: 'durable.example.com',
      zmxTerminalPersistence: false
    })
    expect(disabled.ok).toBe(true)
    if (disabled.ok) {
      // Why: the default is never persisted; updates carries explicit undefined
      // so partial merges clear a previous zmx opt-in.
      expect('terminalPersistenceBackend' in disabled.payload.target).toBe(false)
      expect('terminalPersistenceBackend' in disabled.payload.updates).toBe(true)
      expect(disabled.payload.updates.terminalPersistenceBackend).toBeUndefined()
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
