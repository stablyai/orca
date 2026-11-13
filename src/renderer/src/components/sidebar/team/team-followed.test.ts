import { describe, expect, it } from 'vitest'
import { presence, SELF_ID, workspace } from '../../cloud-workspaces/cloud-workspaces.test-fixture'
import { followOffer } from '../../cloud-workspaces/CloudWorkspacePeople'
import { followedWorkspaces } from './team-activity'

describe('followedWorkspaces (PARITY-FOLLOW)', () => {
  it("lists teammates' workspaces you follow, most recently active first, with who's here", () => {
    const rows = followedWorkspaces(
      [
        workspace({ title: 'Old', createdBy: 'user_grace', following: true, lastActivityAt: 1 }),
        workspace({
          title: 'Checkout',
          number: 582,
          createdBy: 'user_linus',
          following: true,
          lastActivityAt: 9,
          presence: [presence('user_mae'), presence(SELF_ID), presence('user_mae', 'typing')]
        }),
        workspace({ title: 'Not followed', createdBy: 'user_grace', following: false }),
        workspace({ title: 'Mine', createdBy: SELF_ID, following: true }),
        workspace({
          title: 'Asleep',
          createdBy: 'user_grace',
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
    expect(followOffer(workspace({ createdBy: 'user_grace', following: false }), SELF_ID)).toBe(
      false
    )
    expect(followOffer(workspace({ createdBy: 'user_grace', following: true }), SELF_ID)).toBe(true)
    expect(followOffer(workspace({ createdBy: SELF_ID, following: false }), SELF_ID)).toBeNull()
    expect(followOffer(workspace({ createdBy: 'user_grace' }), SELF_ID)).toBeNull()
  })
})
