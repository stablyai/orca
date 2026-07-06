import { describe, expect, it } from 'vitest'
import { canUseLocalAiVaultSessionPathActions } from './ai-vault-session-path-actions'

describe('canUseLocalAiVaultSessionPathActions', () => {
  it('allows OS path actions for local session history', () => {
    expect(canUseLocalAiVaultSessionPathActions('local')).toBe(true)
  })

  it('blocks OS path actions for non-local or unknown session history', () => {
    expect(canUseLocalAiVaultSessionPathActions('ssh:dev-box')).toBe(false)
    expect(canUseLocalAiVaultSessionPathActions('runtime:gpu-box')).toBe(false)
    expect(canUseLocalAiVaultSessionPathActions(undefined)).toBe(false)
  })
})
