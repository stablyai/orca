import { describe, expect, it } from 'vitest'
import type { RuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-subscriptions'
import type { Bot } from '../../../shared/bot-types'
import { botHomeOfSession } from '../../../shared/bots/bot-home-of'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import { botHomeRuleApplies } from './bot-host-capability'

const SHARED: ExecutionHostId = 'runtime:env-shared'
const OLD_SERVER: ExecutionHostId = 'runtime:env-old'
// An older paired server's status: it predates the Home pin.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rule reads only capabilities.
const STATUSES = new Map([
  ['env-old', { status: { capabilities: [] } }]
]) as unknown as RuntimeStatuses
const sharedHost = (hostId: ExecutionHostId) => (hostId === SHARED ? {} : null)

describe('the Home rule on a shared agent', () => {
  it('applies on a shared agent’s host, which has no status here; not on an older paired server', () => {
    expect(botHomeRuleApplies({ hostId: SHARED }, new Map(), sharedHost)).toBe(true)
    expect(botHomeRuleApplies({ hostId: OLD_SERVER }, STATUSES, sharedHost)).toBe(false)
    expect(botHomeRuleApplies({ hostId: 'local' }, new Map(), sharedHost)).toBe(true)
  })

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
