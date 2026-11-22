import { describe, expect, it } from 'vitest'
import { makeTestBot } from '../main/bots/bot.test-fixture'
import { gitHubMembersOf, withGitHubMembersTagged } from './bot-types'
import { applyBotUpdates } from './rpc-contract/bots-params'

describe('GitHub people per org', () => {
  const alice = { id: '101', name: 'alice', source: 'github' }

  it('puts people saved before orgs had rows in each org the bot is in, never a later one', () => {
    const bot = makeTestBot({
      github: { removedInstallationIds: ['9'] },
      members: [alice, { id: 'U1', name: 'Ada' }]
    })
    const tagged = withGitHubMembersTagged(bot, ['7', '8', '9'])
    expect(tagged.members).toEqual([
      { ...alice, workspaceId: '7' },
      { ...alice, workspaceId: '8' },
      { id: 'U1', name: 'Ada' }
    ])
    // Once tagged, nothing changes again, and an org added later starts with nobody.
    expect(withGitHubMembersTagged(tagged, ['7', '8', '10'])).toBe(tagged)
    expect(gitHubMembersOf(tagged.members, '10')).toEqual([])
    // Orgs not known yet tag nobody.
    expect(withGitHubMembersTagged(bot, [])).toBe(bot)
  })

  it('removes a person from one org only', () => {
    const bot = withGitHubMembersTagged(makeTestBot({ github: {}, members: [alice] }), ['7', '8'])
    const after = applyBotUpdates(bot, {
      removeMember: { id: '101', source: 'github', workspaceId: '7' }
    })
    expect(gitHubMembersOf(after.members, '7')).toEqual([])
    expect(gitHubMembersOf(after.members, '8')).toEqual([{ ...alice, workspaceId: '8' }])
  })

  it('takes one Linear workspace off the current list, keeping one added elsewhere', () => {
    const a = { workspaceId: 'a', workspaceName: 'A' }
    const b = { workspaceId: 'b', workspaceName: 'B' }
    const c = { workspaceId: 'c', workspaceName: 'C' }
    const after = applyBotUpdates(makeTestBot({ linear: a, linearWorkspaces: [a, b, c] }), {
      removeLinearWorkspaceId: 'a'
    })
    expect(after.linearWorkspaces).toEqual([b, c])
    expect(after.linear).toEqual(b)
  })

  it('adds one removed GitHub org to the current list, keeping one removed elsewhere', () => {
    const after = applyBotUpdates(makeTestBot({ github: { removedInstallationIds: ['2'] } }), {
      removeGitHubInstallationId: '1'
    })
    expect(after.github?.removedInstallationIds).toEqual(['2', '1'])
  })

  it('refuses a removal delta that would pass the removed-org limit', () => {
    const ids = Array.from({ length: 100 }, (_, i) => String(i))
    expect(() =>
      applyBotUpdates(makeTestBot({ github: { removedInstallationIds: ids } }), {
        removeGitHubInstallationId: 'new'
      })
    ).toThrow('bot_github_removed_full')
  })
})
