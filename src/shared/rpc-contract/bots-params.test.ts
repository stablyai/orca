import { describe, expect, it } from 'vitest'
import { applyBotMemberUpdates } from './bots-params'

const sam = { id: 'U-sam', name: 'Sam', source: 'slack', workspaceId: 'T1' }
const bea = { id: 'L-bea', name: 'Bea', source: 'linear', workspaceId: 'org-1' }
const jane = { id: 'U-jane', name: 'Jane', source: 'slack', workspaceId: 'T1' }

describe('applyBotMemberUpdates', () => {
  it('takes off only the people named, keeping a revoke made elsewhere meanwhile', () => {
    // The host already lost Bea; a Keep only me from a Slack list that still showed her names only Sam.
    expect(
      applyBotMemberUpdates([sam], {
        removeMembers: [{ id: 'U-sam', source: 'slack', workspaceId: 'T1' }]
      })
    ).toEqual([])
  })

  it('adds to the list the host has now, without bringing back someone removed elsewhere', () => {
    expect(applyBotMemberUpdates([bea], { addMembers: [jane] })).toEqual([bea, jane])
  })

  it('adds a person once, however often they are sent', () => {
    expect(applyBotMemberUpdates([jane], { addMembers: [jane, jane] })).toEqual([jane])
  })
})
