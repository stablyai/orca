import { describe, expect, it } from 'vitest'
import { makeTestBot } from '../../main/bots/bot.test-fixture'
import { makeAccessRequest } from './bot-access-request.test-fixture'
import { BOT_MAX_MEMBERS } from '../bot-types'
import {
  accessRequestIdentity,
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
  it('belong to the bot and the connector workspace it is in now', () => {
    expect(botTakesAccessRequest(slackBot, makeAccessRequest())).toBe(true)
    expect(botTakesAccessRequest(slackBot, makeAccessRequest({ workspaceId: 'T2' }))).toBe(false)
    expect(botTakesAccessRequest(slackBot, makeAccessRequest({ botId: 'other' }))).toBe(false)
    expect(
      botTakesAccessRequest(linearBot, makeAccessRequest({ source: 'linear', workspaceId: 'L1' }))
    ).toBe(true)
  })

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

  it('add the person stamped with the connector they asked from', () => {
    expect(grantAccessRequest(slackBot, makeAccessRequest())).toEqual({
      kind: 'add',
      members: [{ id: 'U9', name: 'Dana Kim', source: 'slack', workspaceId: 'T1' }]
    })
    expect(
      grantAccessRequest(linearBot, makeAccessRequest({ source: 'linear', workspaceId: 'L1' }))
    ).toEqual({
      kind: 'add',
      members: [{ id: 'U9', name: 'Dana Kim', source: 'linear', workspaceId: 'L1' }]
    })
  })

  it('only close a request whose person is already listed, and refuse a full list', () => {
    const listed = makeTestBot({
      slack: { appId: 'A1', teamId: 'T1' },
      members: [{ id: 'U9', name: 'Dana', source: 'slack' }]
    })
    const full = makeTestBot({
      slack: { appId: 'A1', teamId: 'T1' },
      members: Array.from({ length: BOT_MAX_MEMBERS }, (_, index) => ({
        id: `U${index + 100}`,
        name: `Person ${index}`
      }))
    })

    expect(grantAccessRequest(listed, makeAccessRequest())).toEqual({ kind: 'listed' })
    expect(grantAccessRequest(full, makeAccessRequest())).toEqual({ kind: 'full' })
    expect(grantAccessRequest(slackBot, makeAccessRequest({ workspaceId: 'T2' }))).toEqual({
      kind: 'not-this-bot'
    })
  })

  it('lead a Linear identity with its verified email', () => {
    expect(
      accessRequestIdentity(
        makeAccessRequest({
          source: 'linear',
          requester: { id: 'u', name: 'Dana', handle: 'dana', detail: 'dana@acme.dev' }
        })
      )
    ).toBe('dana@acme.dev · @dana')
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
