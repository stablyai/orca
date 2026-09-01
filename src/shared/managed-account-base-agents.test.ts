import { describe, expect, it } from 'vitest'
import { baseAgentUsesManagedAccount } from './managed-account-base-agents'

describe('baseAgentUsesManagedAccount', () => {
  it('is true for the Codex and Claude bases that have managed account state', () => {
    expect(baseAgentUsesManagedAccount('codex')).toBe(true)
    expect(baseAgentUsesManagedAccount('claude')).toBe(true)
  })

  it('is false for bases with no Orca-managed account to override', () => {
    expect(baseAgentUsesManagedAccount('aider')).toBe(false)
    expect(baseAgentUsesManagedAccount('gemini')).toBe(false)
    expect(baseAgentUsesManagedAccount('openclaude')).toBe(false)
  })
})
