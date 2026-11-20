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
})

it('drops a saved agent copy that names another agent', () => {
  const bot = makeTestBot({ agent: 'claude', agentCopy: 'claude.code-mode' })
  expect(applyBotUpdates(bot, { agentCopy: 'codex.fast' }).agentCopy).toBeUndefined()
  expect(applyBotUpdates(bot, { agent: 'codex', agentCopy: 'claude.code-mode' }).agentCopy).toBe(
    undefined
  )
  expect(applyBotUpdates(bot, { name: 'Renamed' }).agentCopy).toBe('claude.code-mode')
})
