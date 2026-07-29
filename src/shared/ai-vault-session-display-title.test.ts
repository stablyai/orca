import { describe, expect, it } from 'vitest'
import {
  aiVaultProviderSessionKey,
  resolveAiVaultSessionDisplayTitle
} from './ai-vault-session-display-title'

describe('resolveAiVaultSessionDisplayTitle', () => {
  it('prefers a non-empty Orca custom title', () => {
    expect(resolveAiVaultSessionDisplayTitle('Scanner title', 'My rename')).toBe('My rename')
  })

  it('falls through blank or whitespace custom titles', () => {
    expect(resolveAiVaultSessionDisplayTitle('Scanner title', null)).toBe('Scanner title')
    expect(resolveAiVaultSessionDisplayTitle('Scanner title', undefined)).toBe('Scanner title')
    expect(resolveAiVaultSessionDisplayTitle('Scanner title', '   ')).toBe('Scanner title')
  })
})

describe('aiVaultProviderSessionKey', () => {
  it('keeps distinct agent/session pairs distinct', () => {
    expect(aiVaultProviderSessionKey('codex', 'a')).not.toBe(
      aiVaultProviderSessionKey('claude', 'a')
    )
    expect(aiVaultProviderSessionKey('codex', 'a')).not.toBe(
      aiVaultProviderSessionKey('codex', 'b')
    )
  })
})
