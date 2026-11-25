import { describe, expect, it } from 'vitest'
import { BotSharesSchema } from '../../../../../shared/bots/bot-team-shares'
import { botNotShared, botSharingState, botSharingValue } from './bot-sharing-state'

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
const LINK = { url: 'https://orca.example/s/x', updatedAt: 1 }
const WORDS = { on: 'On', off: 'Off' }

describe('an agent shared two ways', () => {
  it('reads Not shared only with no teammates and no copy link', () => {
    const cases = [
      { shares: [], link: null, notShared: true, value: 'Off' },
      { shares: STORED, link: null, notShared: false, value: 'Dara, sam@acme.co' },
      { shares: [], link: LINK, notShared: false, value: 'On' },
      { shares: STORED, link: LINK, notShared: false, value: 'Dara, sam@acme.co' }
    ]
    for (const { shares, link, notShared, value } of cases) {
      const state = botSharingState(shares, link)
      expect(botNotShared(state)).toBe(notShared)
      expect(botSharingValue(state, WORDS)).toBe(value)
    }
  })

  it('waits for the copy link before saying Off, but names teammates at once', () => {
    expect(botSharingValue(botSharingState(undefined, undefined), WORDS)).toBeNull()
    expect(botNotShared(botSharingState(undefined, undefined))).toBe(false)
    expect(botSharingValue(botSharingState(STORED, undefined), WORDS)).toBe('Dara, sam@acme.co')
  })
})
