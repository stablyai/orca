import { describe, expect, it } from 'vitest'
import { MAX_SSH_SERVICE_LINKS } from '../../../../shared/ssh-service-links'
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

  it('persists trimmed service links and clears the field when the list is emptied', () => {
    const saved = buildSshTargetSavePayload({
      ...EMPTY_FORM,
      host: 'grafana.example.com',
      serviceLinks: [
        { id: 'row-1', label: ' Grafana ', url: ' https://build-box.example.ts.net ' }
      ]
    })

    expect(saved.ok).toBe(true)
    if (!saved.ok) {
      throw new Error(saved.error)
    }
    // Why: the draft id is render identity only, so save must not carry it into storage.
    expect(saved.payload.target.serviceLinks).toEqual([
      { label: 'Grafana', url: 'https://build-box.example.ts.net' }
    ])
    expect(saved.payload.target.serviceLinks?.[0]).not.toHaveProperty('id')
    expect(saved.payload.updates.serviceLinks).toEqual([
      { label: 'Grafana', url: 'https://build-box.example.ts.net' }
    ])

    const cleared = buildSshTargetSavePayload({ ...EMPTY_FORM, host: 'grafana.example.com' })

    expect(cleared.ok).toBe(true)
    if (!cleared.ok) {
      throw new Error(cleared.error)
    }
    expect(cleared.payload.target).not.toHaveProperty('serviceLinks')
    // Why: the update merge needs the explicit undefined to remove a link the user deleted.
    expect(cleared.payload.updates.serviceLinks).toBeUndefined()
  })

  it('rejects a service link whose URL is not http(s) or whose label is empty', () => {
    const badUrl = buildSshTargetSavePayload({
      ...EMPTY_FORM,
      host: 'grafana.example.com',
      serviceLinks: [{ id: 'row-1', label: 'Grafana', url: 'javascript:alert(1)' }]
    })
    const emptyLabel = buildSshTargetSavePayload({
      ...EMPTY_FORM,
      host: 'grafana.example.com',
      serviceLinks: [{ id: 'row-1', label: '  ', url: 'https://grafana.example.com' }]
    })

    for (const result of [badUrl, emptyLabel]) {
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('Each service link needs a label of 1 to')
      }
    }
  })

  it('rejects more service links than the maximum', () => {
    const result = buildSshTargetSavePayload({
      ...EMPTY_FORM,
      host: 'grafana.example.com',
      serviceLinks: Array.from({ length: MAX_SSH_SERVICE_LINKS + 1 }, (_, index) => ({
        id: `row-${index}`,
        label: `service-${index}`,
        url: `https://service-${index}.example`
      }))
    })

    expect(result.ok).toBe(false)
  })
})
