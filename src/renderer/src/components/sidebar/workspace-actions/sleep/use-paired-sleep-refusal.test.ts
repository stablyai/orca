// SHARED-MEMBER-SLEEP-HANG: Sleep is disabled only when this account is known not to be the owner and
// known not to be a team admin; anything unknown leaves it enabled.
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}), subscribe: () => () => {} } }))

import { pairedSleepRefusal } from './use-paired-sleep-refusal'

describe('pairedSleepRefusal', () => {
  it('a member on a teammate workspace: refused', () => {
    expect(pairedSleepRefusal('granted', 'member')).toBe('refused')
    expect(pairedSleepRefusal('can_open', 'member')).toBe('refused')
  })

  it('the owner, or a team owner or admin: allowed', () => {
    expect(pairedSleepRefusal('owner', 'member')).toBeNull()
    expect(pairedSleepRefusal('granted', 'admin')).toBeNull()
    expect(pairedSleepRefusal('granted', 'owner')).toBeNull()
  })

  it('unknown access or role: allowed (a refusal then says so)', () => {
    expect(pairedSleepRefusal(null, 'member')).toBeNull()
    expect(pairedSleepRefusal('granted', null)).toBeNull()
  })
})
