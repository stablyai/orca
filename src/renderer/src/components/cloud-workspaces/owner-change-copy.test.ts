import { describe, expect, it } from 'vitest'
import type { Translate } from '@/i18n/use-translate'
import type { OwnerChangeNotice } from '../../../../shared/cloud-workspaces/owner-change-wire'
import {
  ownerChangeConsequences,
  ownerChangeRefusal,
  previousOwnerNotice,
  previousOwnerToast
} from './owner-change-copy'

// English defaults with {{slots}} filled, like i18next with no catalog.
const t: Translate = (_key, fallback, params) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_slot, name: string) => {
    const value = params?.[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  })

const notice = (overrides: Partial<OwnerChangeNotice> = {}): OwnerChangeNotice => ({
  id: 'otn_1',
  kind: 'workspace_owner_changed',
  workspace: { id: 'sbx_1', name: 'Checkout retries', number: 12 },
  actor: { userId: 'user_grace', name: 'Grace Hopper' },
  newOwner: { userId: 'user_linus', name: 'Linus Park' },
  at: 1,
  ...overrides
})

describe('owner change copy (OWNER-TRANSFER)', () => {
  it('lists what the change does, in the owner’s words or naming the owner for an admin', () => {
    const own = ownerChangeConsequences(null, t)
    expect(own).toHaveLength(4)
    expect(own[0]).toBe('It goes to sleep now, and its share links stop working.')
    expect(own[2]).toContain('even if it comes back to you')
    expect(own[3]).toBe('Personal secrets you used in it may still be on its disk.')
    const admin = ownerChangeConsequences('Grace Hopper', t)
    expect(admin[2]).toContain('even if it goes back to Grace Hopper')
    expect(admin[3]).toBe('Personal secrets Grace Hopper used in it may still be on its disk.')
  })

  it('words each refusal, and never says "nothing was changed" for a timeout', () => {
    expect(ownerChangeRefusal('forbidden', 'not_a_member', 'Linus Park', t)).toBe(
      'Linus Park isn’t a member of this team.'
    )
    expect(ownerChangeRefusal('unavailable', 'membership_unavailable', 'Linus Park', t)).toBe(
      'Couldn’t confirm that Linus Park is a member of this team. Try again in a minute.'
    )
    expect(ownerChangeRefusal('conflict', 'sandbox_resuming', 'Linus Park', t)).toBe(
      'This workspace is starting or going to sleep. Try again once it’s done.'
    )
    expect(ownerChangeRefusal('conflict', 'stop_failed', 'Linus Park', t)).toBe(
      'Couldn’t put this workspace to sleep, so the owner didn’t change. Try again.'
    )
    expect(ownerChangeRefusal('conflict', 'sandbox_not_stopped', 'Linus Park', t)).toBe(
      'Someone opened this workspace during the change, so the owner didn’t change. It may be asleep now. Try again.'
    )
    expect(ownerChangeRefusal('timeout', undefined, 'Linus Park', t)).not.toMatch(/nothing/i)
    // Anything else keeps the shared control-plane copy.
    expect(ownerChangeRefusal('forbidden', 'owner_or_admin_only', 'Linus Park', t)).toBeNull()
    expect(ownerChangeRefusal('unavailable', undefined, 'Linus Park', t)).toBeNull()
    expect(ownerChangeRefusal('conflict', 'too_many_devices', 'Linus Park', t)).toBeNull()
  })

  it('tells the admin whether the previous owner will hear about it', () => {
    const previous = { userId: 'user_grace', notified: true, inApp: true, emailed: false }
    expect(previousOwnerToast(previous, 'user_ada', 'Grace Hopper', t)).toBe(
      'Grace Hopper will see a notice in Orca. If they used personal secrets in this workspace, they should rotate them.'
    )
    const left = { userId: 'user_grace', notified: false, inApp: false, emailed: false }
    expect(previousOwnerToast(left, 'user_ada', 'Grace Hopper', t)).toBe(
      'Grace Hopper has left the team, so Orca can’t tell them. If they used personal secrets in this workspace, ask them to rotate them.'
    )
    expect(previousOwnerToast(left, 'user_ada', null, t)).toMatch(/^A former member/)
  })

  it('adds nothing when you were the owner or the control plane did not say', () => {
    const self = { userId: 'user_ada', notified: true, inApp: true, emailed: false }
    expect(previousOwnerToast(self, 'user_ada', 'Ada Lovelace', t)).toBeNull()
    expect(previousOwnerToast(null, 'user_ada', null, t)).toBeNull()
  })

  it('says who did it in the previous owner’s notice', () => {
    const none = (): null => null
    expect(previousOwnerNotice(notice(), 'user_ada', none, t)).toEqual({
      text: 'Grace Hopper made Linus Park the owner of Checkout retries.',
      description:
        'Personal secrets you used in it may still be on its disk, so consider rotating them.'
    })
    const took = notice({ newOwner: { userId: 'user_grace', name: 'Grace Hopper' } })
    expect(previousOwnerNotice(took, 'user_ada', none, t).text).toBe(
      'Grace Hopper took ownership of Checkout retries.'
    )
    const mine = notice({ actor: { userId: 'user_ada', name: 'Ada Lovelace' } })
    expect(previousOwnerNotice(mine, 'user_ada', none, t).text).toBe(
      'You made Linus Park the owner of Checkout retries.'
    )
  })

  it('falls back to the roster, then a plain word, and to the W-number for the workspace', () => {
    const bare = notice({
      workspace: { id: 'sbx_1', name: null, number: 12 },
      actor: { userId: 'user_grace', name: null },
      newOwner: { userId: 'user_linus', name: null }
    })
    const roster = (userId: string): string | null =>
      userId === 'user_grace' ? 'Grace Hopper' : null
    expect(previousOwnerNotice(bare, 'user_ada', roster, t).text).toBe(
      'Grace Hopper made a teammate the owner of W-12.'
    )
  })
})
