import { describe, expect, it } from 'vitest'
import { BotSharesSchema } from '../../../../../shared/bots/bot-team-shares'
import type { BotShareLink } from '../sharing/use-bot-share-link'
import { botSharingState, botSharingValue } from './bot-sharing-state'

// Stored as older Orca wrote them: no acceptedAt, emailedAt or homeSessionId, plus an entry a newer
// Orca wrote, which is dropped on its own.
const STORED = BotSharesSchema.parse([
  {
    kind: 'account',
    shareId: 's1',
    accountId: 'a1',
    name: 'Dara',
    email: 'dara@acme.co',
    addedAt: 1
  },
  { kind: 'invite', shareId: 's2', email: 'sam@acme.co', addedAt: 2 },
  {
    kind: 'account',
    shareId: 's3',
    accountId: 'a3',
    email: 'lee@acme.co',
    addedAt: 3,
    declinedAt: 4
  },
  { kind: 'group', shareId: 's4', addedAt: 5 }
])
const LINK: BotShareLink = {
  shareId: 'share-1',
  url: 'https://orca.example/s/x',
  versionId: 'v1',
  updatedAt: null,
  digest: null
}
const WORDS = { on: 'On', off: 'Off' }

describe('an agent shared two ways', () => {
  it('reads Off only with no teammates and no copy link', () => {
    const cases = [
      { shares: [], link: null, value: 'Off' },
      { shares: STORED, link: null, value: 'Dara, sam@acme.co' },
      { shares: [], link: LINK, value: 'On' },
      { shares: STORED, link: LINK, value: 'Dara, sam@acme.co' }
    ]
    for (const { shares, link, value } of cases) {
      expect(botSharingValue(botSharingState(shares, link), WORDS)).toBe(value)
    }
  })

  it('waits for the copy link before saying Off, but names teammates at once', () => {
    expect(botSharingValue(botSharingState(undefined, undefined), WORDS)).toBeNull()
    expect(botSharingValue(botSharingState(STORED, undefined), WORDS)).toBe('Dara, sam@acme.co')
  })
})
