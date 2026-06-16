import { describe, expect, it } from 'vitest'
import { buildDockerConnectionFromDraft, type DockerConnectionDraft } from './docker-connection-draft'

const base: DockerConnectionDraft = { label: '', kind: 'ssh', sshTargetId: '', tcpHost: '', tcpPort: '' }

describe('buildDockerConnectionFromDraft', () => {
  it('requires a non-empty label', () => {
    expect(buildDockerConnectionFromDraft({ ...base, label: '  ' }, 'id1').ok).toBe(false)
  })
  it('builds an ssh connection from a selected target', () => {
    expect(buildDockerConnectionFromDraft({ ...base, label: 'Box', kind: 'ssh', sshTargetId: 't1' }, 'id1')).toEqual({
      ok: true, connection: { id: 'id1', label: 'Box', kind: 'ssh', sshTargetId: 't1' }
    })
  })
  it('rejects ssh without a target', () => {
    expect(buildDockerConnectionFromDraft({ ...base, label: 'Box', kind: 'ssh', sshTargetId: '' }, 'id1').ok).toBe(false)
  })
  it('builds a tcp connection and coerces the port', () => {
    expect(buildDockerConnectionFromDraft({ ...base, label: 'CI', kind: 'tcp', tcpHost: '10.0.0.5', tcpPort: '2376' }, 'id1')).toEqual({
      ok: true, connection: { id: 'id1', label: 'CI', kind: 'tcp', tcp: { host: '10.0.0.5', port: 2376 } }
    })
  })
  it('rejects tcp with a missing host or non-numeric port', () => {
    expect(buildDockerConnectionFromDraft({ ...base, label: 'CI', kind: 'tcp', tcpHost: '', tcpPort: '2376' }, 'id1').ok).toBe(false)
    expect(buildDockerConnectionFromDraft({ ...base, label: 'CI', kind: 'tcp', tcpHost: 'h', tcpPort: 'abc' }, 'id1').ok).toBe(false)
  })
})
