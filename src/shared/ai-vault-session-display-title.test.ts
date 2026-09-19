import { describe, expect, it } from 'vitest'
import {
  aiVaultProviderSessionKey,
  resolveAiVaultSessionDisplayTitle
} from './ai-vault-session-display-title'

describe('resolveAiVaultSessionDisplayTitle', () => {
  it('prefers a trimmed Orca tab rename over the scanner title', () => {
    expect(
      resolveAiVaultSessionDisplayTitle(
        { title: 'First user prompt', subagent: null },
        '  Payments spike  '
      )
    ).toBe('Payments spike')
  })

  it('falls through to the scanner title when the overlay is blank', () => {
    expect(
      resolveAiVaultSessionDisplayTitle({ title: 'Claude custom-title', subagent: null }, '   ')
    ).toBe('Claude custom-title')
    expect(
      resolveAiVaultSessionDisplayTitle({ title: 'Codex thread_name', subagent: null }, null)
    ).toBe('Codex thread_name')
  })

  it('does not let a parent tab rename replace a subagent row title', () => {
    expect(
      resolveAiVaultSessionDisplayTitle(
        {
          title: 'Task: run tests',
          subagent: { parentSessionId: 'parent', agentType: 'Explore', status: null }
        },
        'Parent rename'
      )
    ).toBe('Task: run tests')
  })

  it('keeps agent and provider session identities distinct as map keys', () => {
    expect(aiVaultProviderSessionKey('claude', 'a\nb')).not.toBe(
      aiVaultProviderSessionKey('claude', 'a')
    )
    expect(aiVaultProviderSessionKey('codex', 'session-1')).not.toBe(
      aiVaultProviderSessionKey('claude', 'session-1')
    )
  })
})
