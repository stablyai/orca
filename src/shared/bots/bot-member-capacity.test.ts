import { describe, expect, it } from 'vitest'
import { applyBotMemberUpdates } from '../rpc-contract/bots-params'
import { botMembersFullError, planBotMemberAdds, readBotMembersFull } from './bot-member-capacity'

const slack = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `U${i}`, name: `S${i}`, source: 'slack' }))
const linear = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `L${i}`,
    name: `L${i}`,
    source: 'linear',
    workspaceId: 'org-1'
  }))

describe('planBotMemberAdds', () => {
  it('refuses the whole add, naming who, when it would pass the bot’s 200 people', () => {
    const plan = planBotMemberAdds(slack(199), [
      { id: 'new-a', name: 'Ann', source: 'slack' },
      { id: 'new-b', name: 'Ben', source: 'slack' }
    ])
    expect(plan).toEqual({ ok: false, full: { scope: 'bot', limit: 200, names: ['Ben'] } })
  })

  it('refuses an add past the 50 people one Linear workspace takes', () => {
    const plan = planBotMemberAdds(linear(49), [
      { id: 'new-a', name: 'Ann', source: 'linear', workspaceId: 'org-1' },
      { id: 'new-b', name: 'Ben', source: 'linear', workspaceId: 'org-1' }
    ])
    expect(plan).toEqual({ ok: false, full: { scope: 'workspace', limit: 50, names: ['Ben'] } })
  })
})

describe('applyBotMemberUpdates at a limit', () => {
  it('removes the named member and adds a person once in a workspace with room', () => {
    const fullWorkspace = linear(50)
    const revoked = { id: 'revoked', name: 'Ben', source: 'linear', workspaceId: 'org-2' }
    const added = { id: 'new-a', name: 'Ann', source: 'linear', workspaceId: 'org-2' }

    expect(
      applyBotMemberUpdates([...fullWorkspace, revoked], {
        removeMembers: [{ id: 'revoked', source: 'linear', workspaceId: 'org-2' }],
        addMembers: [added, added]
      })
    ).toEqual([...fullWorkspace, added])
  })

  it('saves nobody and says who, and the owner’s window can read it', () => {
    let thrown: unknown
    try {
      applyBotMemberUpdates(linear(50), {
        addMembers: [{ id: 'new-a', name: 'Ann', source: 'linear', workspaceId: 'org-1' }]
      })
    } catch (error) {
      thrown = error
    }
    expect(readBotMembersFull(thrown)).toEqual({ scope: 'workspace', limit: 50, names: ['Ann'] })
  })

  it('reads only its own error', () => {
    expect(readBotMembersFull(new Error('bot_name_taken'))).toBeNull()
    expect(
      readBotMembersFull(botMembersFullError({ scope: 'bot', limit: 200, names: ['Ann'] }))
    ).toEqual({ scope: 'bot', limit: 200, names: ['Ann'] })
  })
})
