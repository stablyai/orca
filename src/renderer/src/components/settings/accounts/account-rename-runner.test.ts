import { describe, expect, it } from 'vitest'
import { withRenamedAccount } from './account-rename-runner'

describe('withRenamedAccount', () => {
  it('applies a late rename reply without undoing a newer selection or removal', () => {
    // The rename reply was built while A and B existed and B was selected.
    const reply = {
      activeAccountId: 'b',
      accounts: [
        { id: 'a', email: 'a@example.com', displayName: 'Work' },
        { id: 'b', email: 'b@example.com' }
      ]
    }
    // Meanwhile C was selected and B removed.
    const current = {
      activeAccountId: 'c',
      accounts: [
        { id: 'a', email: 'a@example.com' },
        { id: 'c', email: 'c@example.com' }
      ]
    }
    expect(withRenamedAccount(current, reply, 'a')).toEqual({
      activeAccountId: 'c',
      accounts: [
        { id: 'a', email: 'a@example.com', displayName: 'Work' },
        { id: 'c', email: 'c@example.com' }
      ]
    })
    // A rename of an account removed meanwhile does not bring it back.
    expect(withRenamedAccount(current, reply, 'b')).toBe(current)
  })
})
