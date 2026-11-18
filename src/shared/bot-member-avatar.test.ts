import { describe, expect, it } from 'vitest'
import { BotMemberSchema } from './bot-types'
import { ConnectorBotSlackMembersResponse } from './connector-bot-slack-contract'

const SLACK_PHOTO = 'https://avatars.slack-edge.com/sam_72.png'

describe('a bot member’s picture', () => {
  it('keeps a picture from a host the avatar cache serves', () => {
    expect(BotMemberSchema.parse({ id: 'U1', name: 'Sam', avatarUrl: SLACK_PHOTO })).toEqual({
      id: 'U1',
      name: 'Sam',
      avatarUrl: SLACK_PHOTO
    })
  })

  it('drops any other picture, keeping the person', () => {
    for (const avatarUrl of [
      'https://example.com/a.png',
      'http://avatars.slack-edge.com/a.png',
      7
    ]) {
      expect(BotMemberSchema.parse({ id: 'U1', name: 'Sam', avatarUrl })).toEqual({
        id: 'U1',
        name: 'Sam'
      })
    }
  })

  it('drops it from a member search answer too', () => {
    expect(
      ConnectorBotSlackMembersResponse.parse({
        members: [
          { id: 'U1', name: 'Sam', avatarUrl: SLACK_PHOTO },
          { id: 'U2', name: 'Eli', avatarUrl: 'https://example.com/e.png' }
        ],
        complete: true
      }).members
    ).toEqual([
      { id: 'U1', name: 'Sam', avatarUrl: SLACK_PHOTO },
      { id: 'U2', name: 'Eli' }
    ])
  })
})
