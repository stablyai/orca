import { describe, expect, it } from 'vitest'
import { canCopyClaudeSignInLink, isClaudeLocalSignInLink } from './claude-sign-in-link'

function link(base: string, redirect: string): string {
  const url = new URL(base)
  url.searchParams.set('code', 'true')
  url.searchParams.set('redirect_uri', redirect)
  url.searchParams.set('state', 'abc')
  return url.toString()
}

describe('isClaudeLocalSignInLink', () => {
  it('accepts the link Claude hands BROWSER', () => {
    expect(
      isClaudeLocalSignInLink(
        link('https://claude.com/cai/oauth/authorize', 'http://localhost:51234/callback')
      )
    ).toBe(true)
    expect(
      isClaudeLocalSignInLink(
        link('https://claude.ai/oauth/authorize', 'http://localhost:1/callback')
      )
    ).toBe(true)
  })

  it('refuses the printed pasted-code link and anything not from Claude', () => {
    expect(
      isClaudeLocalSignInLink(
        link(
          'https://claude.com/cai/oauth/authorize',
          'https://platform.claude.com/oauth/code/callback'
        )
      )
    ).toBe(false)
    expect(
      isClaudeLocalSignInLink(
        link('https://claude.com.evil.test/oauth/authorize', 'http://localhost:1/callback')
      )
    ).toBe(false)
    expect(
      isClaudeLocalSignInLink(
        link('http://claude.com/cai/oauth/authorize', 'http://localhost:1/callback')
      )
    ).toBe(false)
    expect(
      isClaudeLocalSignInLink(
        link('https://claude.com/cai/oauth/authorize', 'http://attacker.test/callback')
      )
    ).toBe(false)
    expect(isClaudeLocalSignInLink('not a url')).toBe(false)
  })
})

describe('canCopyClaudeSignInLink', () => {
  it('is offered everywhere but a Windows host sign-in', () => {
    expect(canCopyClaudeSignInLink(false, 'host')).toBe(true)
    expect(canCopyClaudeSignInLink(false, undefined)).toBe(true)
    expect(canCopyClaudeSignInLink(true, 'wsl')).toBe(true)
    expect(canCopyClaudeSignInLink(true, 'host')).toBe(false)
    expect(canCopyClaudeSignInLink(true, undefined)).toBe(false)
  })
})
