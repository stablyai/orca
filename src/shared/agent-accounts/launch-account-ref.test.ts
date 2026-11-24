import { describe, expect, it } from 'vitest'
import type { ClaudeManagedAccount } from './managed-account-types'
import { resolveClaudeAccountRef } from './launch-account-ref'

function account(id: string, email: string): ClaudeManagedAccount {
  return {
    id,
    email,
    managedAuthPath: `/tmp/${id}`,
    authMethod: 'subscription-oauth',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

const accounts = [account('a1', 'work@example.com'), account('a2', 'home@example.com')]
const names = { claude: { a2: 'Home' } }

describe('resolveClaudeAccountRef', () => {
  it('matches a saved account by id, email or label, and system by name', () => {
    expect(resolveClaudeAccountRef('a1', accounts, names)).toEqual({
      kind: 'managed',
      accountId: 'a1'
    })
    expect(resolveClaudeAccountRef('HOME@example.com', accounts, names)).toEqual({
      kind: 'managed',
      accountId: 'a2'
    })
    expect(resolveClaudeAccountRef('home', accounts, names)).toEqual({
      kind: 'managed',
      accountId: 'a2'
    })
    expect(resolveClaudeAccountRef('System', accounts, names)).toEqual({ kind: 'system' })
  })

  it('never guesses: an unknown or ambiguous ref matches nothing', () => {
    expect(resolveClaudeAccountRef('nobody', accounts, names)).toBeNull()
    const twins = [account('b1', 'same@example.com'), account('b2', 'same@example.com')]
    expect(resolveClaudeAccountRef('same@example.com', twins)).toBeNull()
  })
})
