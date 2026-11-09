import { describe, expect, it } from 'vitest'
import { differentAccountEmail, selectedAccountEmail } from './desktop-agent-account'

const account = (id: string, email: string) => ({
  id,
  email,
  authMethod: 'subscription-oauth' as const,
  createdAt: 0,
  updatedAt: 0,
  lastAuthenticatedAt: 0
})

describe('desktop agent account', () => {
  it('uses the selected account, else the System default login', () => {
    const accounts = [account('a', 'work@example.com'), account('b', 'home@example.com')]
    expect(
      selectedAccountEmail('claude', {
        accounts,
        activeAccountId: 'a',
        activeAccountIdsByRuntime: { host: 'b', wsl: {} }
      })
    ).toBe('home@example.com')
    expect(
      selectedAccountEmail('claude', {
        accounts,
        activeAccountId: null,
        systemDefaultEmail: 'default@example.com'
      })
    ).toBe('default@example.com')
    expect(
      selectedAccountEmail('codex', {
        accounts: [],
        activeAccountId: null,
        systemDefault: {
          hasAuth: true,
          authKind: 'oauth',
          email: 'codex@example.com',
          providerAccountId: null,
          workspaceLabel: null
        }
      })
    ).toBe('codex@example.com')
  })

  it('warns only when both accounts are known and differ', () => {
    expect(differentAccountEmail('Me@Example.com', 'me@example.com ')).toBeNull()
    expect(differentAccountEmail('other@example.com', null)).toBeNull()
    expect(differentAccountEmail(null, 'me@example.com')).toBeNull()
    expect(differentAccountEmail('other@example.com', 'me@example.com')).toBe('me@example.com')
  })
})
