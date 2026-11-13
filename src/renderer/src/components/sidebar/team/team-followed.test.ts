import { describe, expect, it } from 'vitest'
import { presence, SELF_ID, workspace } from '../../cloud-workspaces/cloud-workspaces.test-fixture'
import { followOffer } from '../../cloud-workspaces/CloudWorkspacePeople'
import { followedWorkspaces } from './team-activity'

describe('followedWorkspaces (PARITY-FOLLOW)', () => {
  it("lists teammates' workspaces you follow, most recently active first, with who's here", () => {
    const rows = followedWorkspaces(
      [
        workspace({
          title: 'Old',
          createdBy: 'user_grace',
          ownerUserId: 'user_grace',
          following: true,
          lastActivityAt: 1
        }),
        workspace({
          title: 'Checkout',
          number: 582,
          createdBy: 'user_linus',
          ownerUserId: 'user_linus',
          following: true,
          lastActivityAt: 9,
          presence: [presence('user_mae'), presence(SELF_ID), presence('user_mae', 'typing')]
        }),
        workspace({
          title: 'Not followed',
          createdBy: 'user_grace',
          ownerUserId: 'user_grace',
          following: false
        }),
        workspace({ title: 'Mine', createdBy: SELF_ID, following: true }),
        // Handed to you by its creator: yours now, so it leaves Following.
        workspace({
          title: 'Handed to me',
          createdBy: 'user_grace',
          ownerUserId: SELF_ID,
          following: true,
          ownershipTransferredAt: 5
        }),
        workspace({
          title: 'Asleep',
          createdBy: 'user_grace',
          ownerUserId: 'user_grace',
          following: true,
          status: 'suspended',
          lastActivityAt: 0
        })
      ],
      SELF_ID
    )
    expect(rows.map((r) => [r.title, r.status, r.hereNow, r.numberLabel])).toEqual([
      ['Checkout', 'running', 1, 'W-582'],
      ['Old', 'running', 0, expect.any(String)],
      ['Asleep', 'asleep', 0, expect.any(String)]
    ])
  })
})

describe('followOffer (PARITY-FOLLOW)', () => {
  it("offers Follow on a teammate's workspace, never on your own or from an older control plane", () => {
    const grace = { createdBy: 'user_grace', ownerUserId: 'user_grace' }
    expect(followOffer(workspace({ ...grace, following: false }), SELF_ID)).toBe(false)
    expect(followOffer(workspace({ ...grace, following: true }), SELF_ID)).toBe(true)
    expect(followOffer(workspace({ createdBy: SELF_ID, following: false }), SELF_ID)).toBeNull()
    expect(followOffer(workspace(grace), SELF_ID)).toBeNull()
  })

  it('follows the current owner after a hand-off, not the creator (FOLLOW-OWN-AFTER-TRANSFER)', () => {
    // Created by Grace, handed to me: mine now, so no Follow.
    const handedToMe = workspace({
      createdBy: 'user_grace',
      ownerUserId: SELF_ID,
      following: false,
      ownershipTransferredAt: 5
    })
    expect(followOffer(handedToMe, SELF_ID)).toBeNull()
    // Created by me, handed to Grace: hers now, so I may follow it.
    const handedAway = workspace({
      createdBy: SELF_ID,
      ownerUserId: 'user_grace',
      following: false,
      ownershipTransferredAt: 5
    })
    expect(followOffer(handedAway, SELF_ID)).toBe(false)
  })

  it('a hand-off arriving in a live refresh changes the offer with no reload', () => {
    const before = workspace({
      createdBy: 'user_grace',
      ownerUserId: 'user_grace',
      following: true
    })
    expect(followOffer(before, SELF_ID)).toBe(true)
    const after = { ...before, ownerUserId: SELF_ID, ownershipTransferredAt: 9 }
    expect(followOffer(after, SELF_ID)).toBeNull()
    expect(followedWorkspaces([before], SELF_ID)).toHaveLength(1)
    expect(followedWorkspaces([after], SELF_ID)).toHaveLength(0)
  })
})
