import { describe, expect, it } from 'vitest'
import { canCopyClaudeSignInLink } from './claude-sign-in-link'

describe('canCopyClaudeSignInLink', () => {
  it('is offered everywhere but a Windows host sign-in', () => {
    expect(canCopyClaudeSignInLink(false, 'host')).toBe(true)
    expect(canCopyClaudeSignInLink(false, undefined)).toBe(true)
    expect(canCopyClaudeSignInLink(true, 'wsl')).toBe(true)
    expect(canCopyClaudeSignInLink(true, 'host')).toBe(false)
    expect(canCopyClaudeSignInLink(true, undefined)).toBe(false)
  })
})
