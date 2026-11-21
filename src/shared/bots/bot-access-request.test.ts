import { describe, expect, it } from 'vitest'
import { makeTestBot } from '../../main/bots/bot.test-fixture'
import { makeAccessRequest } from './bot-access-request.test-fixture'
import {
  addBotMembers,
  type BotMemberList,
  botTakesAccessRequest,
  grantAccessRequest
} from './bot-access-request'

const slackBot = makeTestBot({ slack: { appId: 'A1', teamId: 'T1' } })
const linearBot = makeTestBot({
  linear: { workspaceId: 'L1', workspaceName: 'Acme', urlKey: 'acme' }
})

describe('bot access requests', () => {
  it('belong to every workspace the bot is in, each adding to its own list', () => {
    const both = makeTestBot({
      slack: { appId: 'A1', teamId: 'T1' },
      slackApps: [
        { appId: 'A1', teamId: 'T1' },
        { appId: 'A2', teamId: 'T2' }
      ],
      linear: { workspaceId: 'L1', workspaceName: 'Acme' },
      linearWorkspaces: [
        { workspaceId: 'L1', workspaceName: 'Acme' },
        { workspaceId: 'L2', workspaceName: 'Beta' }
      ],
      // On T1's list only, so a T2 ask still adds them there.
      members: [{ id: 'U9', name: 'Dana Kim', source: 'slack', workspaceId: 'T1' }]
    })
    expect(botTakesAccessRequest(both, makeAccessRequest({ workspaceId: 'T3' }))).toBe(false)
    expect(grantAccessRequest(both, makeAccessRequest({ workspaceId: 'T2' }))).toEqual({
      kind: 'add',
      members: [
        { id: 'U9', name: 'Dana Kim', source: 'slack', workspaceId: 'T1' },
        { id: 'U9', name: 'Dana Kim', source: 'slack', workspaceId: 'T2' }
      ]
    })
    expect(
      botTakesAccessRequest(both, makeAccessRequest({ source: 'linear', workspaceId: 'L2' }))
    ).toBe(true)
  })

  it('stamps a request from the legacy Linear workspace on that workspace’s list', () => {
    expect(
      grantAccessRequest(linearBot, makeAccessRequest({ source: 'linear', workspaceId: 'L1' }))
    ).toEqual({
      kind: 'add',
      members: [{ id: 'U9', name: 'Dana Kim', source: 'linear', workspaceId: 'L1' }]
    })
  })

  it('recognizes an already-listed person and rejects requests from another workspace', () => {
    const listed = makeTestBot({
      slack: { appId: 'A1', teamId: 'T1' },
      members: [{ id: 'U9', name: 'Dana', source: 'slack' }]
    })
    expect(grantAccessRequest(listed, makeAccessRequest())).toEqual({ kind: 'listed' })
    expect(grantAccessRequest(slackBot, makeAccessRequest({ workspaceId: 'T2' }))).toEqual({
      kind: 'not-this-bot'
    })
  })

  it("add picked people to one connector's list, stamped, keeping anyone it already lists", () => {
    const linearList: BotMemberList = {
      listed: (members) => members.filter((member) => member.source === 'linear'),
      stamp: { source: 'linear', workspaceId: 'L1' }
    }
    const members = [
      { id: 'U1', name: 'Lin', source: 'linear', workspaceId: 'L1' },
      { id: 'U2', name: 'Sam', source: 'slack' }
    ]

    expect(
      addBotMembers(
        members,
        [
          { id: 'U1', name: 'Lin again' },
          { id: 'U2', name: 'Sam on Linear' }
        ],
        linearList
      )
    ).toEqual([
      ...members,
      { id: 'U2', name: 'Sam on Linear', source: 'linear', workspaceId: 'L1' }
    ])
  })
})
