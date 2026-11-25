import { describe, expect, it } from 'vitest'
import type { BotShare } from '../../../../../shared/bots/bot-team-shares'
import { teamSharePeople, teamShareSuggestions } from './bot-team-share-people'

const invited: BotShare = {
  kind: 'invite',
  shareId: 'a',
  email: 'alice@example.com',
  addedAt: 1,
  emailedAt: 2
}
const waiting: BotShare = { kind: 'invite', shareId: 'b', email: 'bo@example.com', addedAt: 1 }
const hasAccess: BotShare = {
  kind: 'account',
  shareId: 'c',
  accountId: 'acct-cy',
  email: 'cy@example.com',
  addedAt: 1
}

describe('share dialog rows', () => {
  it('reads Invited, Email not sent yet and Has access from the share list', () => {
    expect(teamSharePeople([invited, waiting, hasAccess])).toEqual([
      { kind: 'invite', key: 'a', email: 'alice@example.com', emailSent: true },
      { kind: 'invite', key: 'b', email: 'bo@example.com', emailSent: false },
      { kind: 'account', key: 'c', name: 'cy@example.com', email: 'cy@example.com', links: [] }
    ])
  })

  it('a removed invite or account leaves both lists', () => {
    const after = [invited, waiting, hasAccess].filter(
      (share) => share.shareId !== 'b' && share.shareId !== 'c'
    )
    expect(teamSharePeople(after).map((person) => person.key)).toEqual(['a'])
  })

  it('offers an invite only for a new, valid email', () => {
    expect(teamShareSuggestions('  ', [])).toBeNull()
    expect(teamShareSuggestions('bob', [])).toEqual([])
    expect(teamShareSuggestions(' Dee@Example.com', [invited])).toEqual([
      { kind: 'invite', key: 'dee@example.com', email: 'dee@example.com' }
    ])
    expect(teamShareSuggestions('ALICE@example.com', [invited])).toEqual([])
  })
})
