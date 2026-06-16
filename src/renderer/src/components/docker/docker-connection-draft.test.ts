import { describe, expect, it } from 'vitest'
import {
  buildDockerConnectionFromDraft,
  type DockerConnectionDraft
} from './docker-connection-draft'

const base: DockerConnectionDraft = {
  label: '',
  kind: 'ssh',
  sshTargetId: '',
  tcpHost: '',
  tcpPort: ''
}

describe('buildDockerConnectionFromDraft', () => {
  it('requires a non-empty label', () => {
    const r = buildDockerConnectionFromDraft({ ...base, label: '  ' }, 'id1')
    expect(r.ok).toBe(false)
    expect(r.ok ? null : r.error).toBe('label_required')
  })
  it('builds an ssh connection from a selected target', () => {
    expect(
      buildDockerConnectionFromDraft(
        { ...base, label: 'Box', kind: 'ssh', sshTargetId: 't1' },
        'id1'
      )
    ).toEqual({
      ok: true,
      connection: { id: 'id1', label: 'Box', kind: 'ssh', sshTargetId: 't1' }
    })
  })
  it('rejects ssh without a target', () => {
    const r = buildDockerConnectionFromDraft(
      { ...base, label: 'Box', kind: 'ssh', sshTargetId: '' },
      'id1'
    )
    expect(r.ok).toBe(false)
    expect(r.ok ? null : r.error).toBe('ssh_target_required')
  })
  it('trims whitespace-only sshTargetId before validation', () => {
    const r = buildDockerConnectionFromDraft(
      { ...base, label: 'Box', kind: 'ssh', sshTargetId: '   ' },
      'id1'
    )
    expect(r.ok).toBe(false)
    expect(r.ok ? null : r.error).toBe('ssh_target_required')
  })
  it('stores the trimmed sshTargetId in the connection', () => {
    const r = buildDockerConnectionFromDraft(
      { ...base, label: 'Box', kind: 'ssh', sshTargetId: 't1' },
      'id1'
    )
    expect(r.ok ? r.connection.sshTargetId : null).toBe('t1')
  })
  it('builds a tcp connection and coerces the port', () => {
    expect(
      buildDockerConnectionFromDraft(
        { ...base, label: 'CI', kind: 'tcp', tcpHost: '10.0.0.5', tcpPort: '2376' },
        'id1'
      )
    ).toEqual({
      ok: true,
      connection: { id: 'id1', label: 'CI', kind: 'tcp', tcp: { host: '10.0.0.5', port: 2376 } }
    })
  })
  it('rejects tcp with a missing host', () => {
    const r = buildDockerConnectionFromDraft(
      { ...base, label: 'CI', kind: 'tcp', tcpHost: '', tcpPort: '2376' },
      'id1'
    )
    expect(r.ok).toBe(false)
    expect(r.ok ? null : r.error).toBe('tcp_host_required')
  })
  it('rejects tcp with a non-numeric port', () => {
    const r = buildDockerConnectionFromDraft(
      { ...base, label: 'CI', kind: 'tcp', tcpHost: 'h', tcpPort: 'abc' },
      'id1'
    )
    expect(r.ok).toBe(false)
    expect(r.ok ? null : r.error).toBe('tcp_port_required')
  })
})
