import { describe, expect, it } from 'vitest'
import { aiVaultSessionHostLabel } from './ai-vault-session-host-label'

const lookups = {
  sshTargetLabels: new Map([['ssh-runner', 'build-box']]),
  removedSshTargetLabels: new Map([['ssh-old', 'retired-box']]),
  runtimeEnvironments: [{ id: 'env-1', name: 'VPS Orca Server' }]
}

describe('aiVaultSessionHostLabel', () => {
  it('shows no badge for sessions on this machine', () => {
    expect(aiVaultSessionHostLabel('local', lookups)).toBeNull()
    expect(aiVaultSessionHostLabel(undefined, lookups)).toBeNull()
  })

  it('names SSH hosts by their target label, never the internal id', () => {
    expect(aiVaultSessionHostLabel('ssh:ssh-runner', lookups)).toBe('build-box')
    expect(aiVaultSessionHostLabel('ssh:ssh-old', lookups)).toBe('retired-box')
  })

  it('names runtime hosts by their environment name', () => {
    expect(aiVaultSessionHostLabel('runtime:env-1', lookups)).toBe('VPS Orca Server')
  })

  it('still marks a remote session whose host is unknown to this client', () => {
    expect(aiVaultSessionHostLabel('ssh:ssh-unknown', lookups)).toBe('ssh-unknown')
  })
})
