import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatComposerNotices } from '../../composer/controls/NativeChatComposerNotices'
import { nativeChatAgentPresenceNotices } from './native-chat-agent-presence-notices'
import type { NativeChatAgentPresence } from '../../../../../../shared/native-chat/agent-presence/native-chat-agent-presence'

function presenceFixture(presence: NativeChatAgentPresence, sessionId: string | null) {
  return defineFixture({
    width: 720,
    render: () => (
      <div className="native-chat-appearance p-4">
        <NativeChatComposerNotices
          notices={nativeChatAgentPresenceNotices({
            presence,
            agent: 'claude',
            sessionId,
            onShowTerminal: () => {},
            onDismissRestart: () => {}
          })}
        />
      </div>
    )
  })
}

export const killedOutOfMemory = presenceFixture(
  { exit: { at: 0, exitCode: 137, sessionId: 'a' }, restartFrom: null },
  'a'
)

export const exitedWithoutCode = presenceFixture(
  { exit: { at: 0, exitCode: null, sessionId: 'a' }, restartFrom: null },
  'a'
)

export const restartedNewSession = presenceFixture(
  { exit: null, restartFrom: { sessionId: 'a' } },
  'b'
)
