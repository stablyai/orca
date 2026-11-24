import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { Bot } from '../../../../../shared/bot-types'
import { BotSlackThreadReplies } from './BotSlackThreadReplies'

const bot: Bot = {
  id: 'thread-replies-fixture',
  name: 'Slack helper',
  hostId: 'local',
  folder: 'slack-helper',
  folderWorkspaceId: 'thread-replies-home',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: { appId: 'A1', teamId: 'T1' },
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}

const setting = (mode: Bot['slackThreadReplies'], supported: boolean) =>
  defineFixture({
    width: 320,
    render: () => (
      <BotSlackThreadReplies bot={{ ...bot, slackThreadReplies: mode }} supported={supported} />
    )
  })

export const always = setting(undefined, true)
export const mentions = setting('mentions', true)
export const unsupported = setting(undefined, false)
export const waiting = setting('mentions', false)
