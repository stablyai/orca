import { describe, expect, it } from 'vitest'
import type { Bot } from '../../../shared/bot-types'
import { botHomeOfSession } from '../../../shared/bots/bot-home-of'

describe('a shared agent’s Home', () => {
  it('finds the viewer’s own Home on a projected bot, and a teammate’s on the owner’s', () => {
    // As the share projects it: no share list, the teammate's own Home in the Home slot.
    const projected: Pick<Bot, 'chatSessionId' | 'shares'> = { chatSessionId: 'alice-home' }
    expect(botHomeOfSession(projected, 'alice-home')).toBe('owner')
    expect(botHomeOfSession(projected, 'alice-side')).toBeNull()
    const owners: Pick<Bot, 'chatSessionId' | 'shares'> = {
      chatSessionId: 'owner-home',
      shares: [
        {
          kind: 'account',
          shareId: 'share-alice',
          accountId: 'acct-alice',
          email: 'alice@example.com',
          addedAt: 1,
          homeSessionId: 'alice-home'
        }
      ]
    }
    expect(botHomeOfSession(owners, 'alice-home')).toEqual({ accountId: 'acct-alice' })
    expect(botHomeOfSession(owners, 'owner-home')).toBe('owner')
  })
})
