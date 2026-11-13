import { describe, expect, it } from 'vitest'
import type { Translate } from '@/i18n/use-translate'
import { leaveBlockedReason, leaveTeamConfirmation } from './team-leave'

const t: Translate = (_key, fallback, options) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ''))

describe('leaveTeamConfirmation', () => {
  it('names the team and carries what leaving costs', () => {
    expect(leaveTeamConfirmation('Orca Staging Eval Team', t)).toEqual({
      title: 'Leave Orca Staging Eval Team?',
      description:
        'You lose access to the team’s cloud workspaces and secrets. An owner or admin can invite you back.',
      confirmLabel: 'Leave team',
      confirmVariant: 'destructive',
      initialFocus: 'cancel'
    })
  })
})

describe('leaveBlockedReason', () => {
  it('lets anyone leave who is not the last owner', () => {
    expect(leaveBlockedReason({ canLeave: true, canDeleteTeam: true }, t)).toBeNull()
  })

  it('blocks the last owner with the way out', () => {
    expect(leaveBlockedReason({ canLeave: false, canDeleteTeam: false }, t)).toBe(
      'You’re the only owner. Make someone else an owner first.'
    )
    expect(leaveBlockedReason({ canLeave: false, canDeleteTeam: true }, t)).toBe(
      'You’re the only owner. Make someone else an owner first, or delete the team.'
    )
  })
})
