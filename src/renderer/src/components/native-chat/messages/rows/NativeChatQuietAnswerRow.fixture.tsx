import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { stubBots } from '../../../../component-fixtures/fixture-bots'
import type { Bot } from '../../../../../../shared/bot-types'
import { mascotAvatar } from '../../../../../../shared/bot-avatar'
import { folderWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'
import { NativeChatVisualOwnerContext } from '../../media/visuals/native-chat-visual-owner'
import { MessageRow } from './NativeChatMessageRow'

const SCOUT: Bot = {
  id: 'scout',
  name: 'Scout',
  hostId: 'local',
  folder: 'scout',
  folderWorkspaceId: 'fw-scout',
  agent: 'claude',
  avatar: mascotAvatar('K2'),
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: 'chat-scout',
  createdAt: 1,
  updatedAt: 1
}
const HOME = {
  target: { kind: 'local' as const },
  sessionId: 'chat-scout',
  worktreeId: folderWorkspaceKey('fw-scout')
}

function Quiet({ id, text, acted }: { id: string; text: string; acted?: boolean }) {
  return (
    <MessageRow
      message={{
        id,
        role: 'assistant',
        timestamp: Date.UTC(2026, 10, 17, 1, 46),
        source: 'transcript',
        blocks: [{ type: 'text', text }]
      }}
      inActingTurn={acted}
      expandSignal={false}
      onScrollMessageToTop={() => {}}
    />
  )
}

// A bot's quiet results: only the turn that said and did nothing reads "Nothing to report".
export const quietResults = defineFixture({
  width: 640,
  setup: () => stubBots([SCOUT]),
  render: () => (
    <NativeChatVisualOwnerContext.Provider value={HOME}>
      <div className="native-chat-appearance space-y-6 p-4">
        <Quiet id="silent" text="NO_REPLY" />
        <Quiet id="said" text={'Checked the open reviews; nothing needs a reply.\n\nNO_REPLY'} />
        <Quiet id="commented" text="NO_REPLY" acted />
      </div>
    </NativeChatVisualOwnerContext.Provider>
  )
})
