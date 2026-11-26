import { defineFixture } from '../../../component-fixtures/component-fixture'
import { stubBots } from '../../../component-fixtures/fixture-bots'
import { mascotAvatar } from '../../../../../shared/bot-avatar'
import type { Bot } from '../../../../../shared/bot-types'
import { PairedServerAskCardView } from './NativeChatPairedServerAskStack'

// The agent here the paired server's agent wants to message.
const literature: Bot = {
  id: 'literature',
  name: 'Literature',
  hostId: 'local',
  folder: 'literature',
  folderWorkspaceId: 'fw-literature',
  agent: 'claude',
  avatar: mascotAvatar('H1'),
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: 'chat-literature',
  createdAt: 1,
  updatedAt: 1
}

export const card = defineFixture({
  width: 760,
  setup: () => stubBots([literature]),
  render: () => (
    <PairedServerAskCardView
      card={{
        messageId: 'msg_1',
        environmentId: 'env_m4',
        botId: 'literature',
        rootSession: 'orca_session_id:chat_coding',
        from: {
          label: "Coding on Jinwoo's M4 Air",
          sender: {
            name: 'Coding',
            computer: "Jinwoo's M4 Air",
            bot: { id: 'coding', name: 'Coding', avatar: null }
          }
        },
        subject: 'Which paper is our M(φ) mobility from?',
        body: 'Which paper and equation is our M(φ) mobility from? solver/mobility.py uses M0 * phi * (1 - phi).',
        createdAt: '2026-11-22 10:00:00'
      }}
      submitting={undefined}
      onDecide={() => {}}
    />
  )
})
