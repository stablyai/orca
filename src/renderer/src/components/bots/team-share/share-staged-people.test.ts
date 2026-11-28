import { describe, expect, it, vi } from 'vitest'
import type { BotMember } from '../../../../../shared/bot-types'
import {
  shareStagedPeople,
  type StagedPerson,
  type TeamShareConnectorAdds
} from './share-staged-people'

const invite = (email: string): StagedPerson => ({
  suggestion: { kind: 'invite', key: email, email }
})
const person = (key: string, id: string): StagedPerson => ({
  suggestion: { kind: 'slack', key: `${key}\n${id}`, name: id },
  connector: { key, member: { id, name: id } }
})

describe('Share in the Share dialog', () => {
  it('saves every connector in turn, invites in one call, and leaves out only who failed', async () => {
    const order: string[] = []
    const adds: TeamShareConnectorAdds = new Map<
      string,
      (members: BotMember[]) => Promise<boolean>
    >([
      [
        'slack:T1',
        async (members: BotMember[]) => {
          order.push(`slack ${members.map((m) => m.id).join(',')}`)
          return true
        }
      ],
      [
        'github:1',
        async (members: BotMember[]) => {
          order.push(`github ${members.map((m) => m.id).join(',')}`)
          return false
        }
      ]
    ])
    const addInvites = vi.fn(async () => true)
    const saved = await shareStagedPeople(
      [
        invite('a@x.co'),
        person('slack:T1', 'U1'),
        person('github:1', 'octo'),
        person('slack:T1', 'U2'),
        invite('b@x.co')
      ],
      addInvites,
      adds
    )
    expect(addInvites).toHaveBeenCalledExactlyOnceWith(['a@x.co', 'b@x.co'])
    expect(order).toEqual(['slack U1,U2', 'github octo'])
    expect([...saved].sort()).toEqual(['a@x.co', 'b@x.co', 'slack:T1\nU1', 'slack:T1\nU2'])
  })

  it('keeps invites that failed and people whose connector is gone', async () => {
    const saved = await shareStagedPeople(
      [invite('a@x.co'), person('slack:T9', 'U1')],
      async () => false,
      new Map()
    )
    expect(saved.size).toBe(0)
  })
})
