import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatComposerNotices } from '../../composer/controls/NativeChatComposerNotices'
import { nativeChatAgentPresenceNotices } from './native-chat-agent-presence-notices'
import type { NativeChatAgentPresence } from '../../../../../../shared/native-chat/agent-presence/native-chat-agent-presence'
import type { NativeChatAgentRestart } from './use-native-chat-agent-restart'

function presenceFixture(
  presence: NativeChatAgentPresence,
  sessionId: string | null,
  restart?: Omit<NativeChatAgentRestart, 'restart'>
) {
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
            onDismissRestart: () => {},
            ...(restart ? { restart: { ...restart, restart: () => {} } } : {})
          })}
        />
      </div>
    )
  })
}

const killed: NativeChatAgentPresence = {
  exit: { at: 0, exitCode: 137, sessionId: 'a' },
  restartFrom: null
}

export const killedOutOfMemory = presenceFixture(killed, 'a', {
  phase: { kind: 'idle' },
  canResume: true
})

export const exitedWithoutSession = presenceFixture(
  { exit: { at: 0, exitCode: null, sessionId: null }, restartFrom: null },
  null,
  { phase: { kind: 'idle' }, canResume: false }
)

export const resuming = presenceFixture(killed, 'a', {
  phase: { kind: 'restarting', mode: 'resume' },
  canResume: true
})

export const resumeFailed = presenceFixture(killed, 'a', {
  phase: { kind: 'failed', mode: 'resume', reason: 'held_elsewhere' },
  canResume: true
})

export const restartedNewSession = presenceFixture(
  { exit: null, restartFrom: { sessionId: 'a' } },
  'b',
  { phase: { kind: 'idle' }, canResume: true }
)
