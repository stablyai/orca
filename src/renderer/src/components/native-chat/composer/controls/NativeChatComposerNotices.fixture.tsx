import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatComposerNotices } from './NativeChatComposerNotices'
import { structuredSessionNotices } from '../../messages/notices/native-chat-structured-session-notices'
import { structuredAgentSessionReadFailureNotice } from '../../messages/notices/structured-agent-session-read-failure-notice'
import {
  nativeChatHeldElsewhereNotice,
  nativeChatHeldElsewhereRecoveryNotice
} from './use-native-chat-held-elsewhere-notice'

// Captured retained-opening read refusal: history is absent while creation still owns Retry.
const refusal = {
  code: 'agent_session_identity_required',
  details: { reason: 'recordMissing' }
} as const

export const openingRetry = defineFixture({
  width: 720,
  render: () => (
    <div className="native-chat-appearance p-4">
      <NativeChatComposerNotices
        notices={structuredSessionNotices({
          launch: { lifecycle: 'visibility-unknown', failure: null, retry: () => {} },
          agentLabel: 'Codex',
          sessionError: structuredAgentSessionReadFailureNotice(refusal).text,
          readRefusal: refusal,
          composerError: null
        })}
      />
    </div>
  )
})

export const claudeSignIn = defineFixture({
  width: 720,
  render: () => (
    <div className="native-chat-appearance p-4">
      <NativeChatComposerNotices
        notices={structuredSessionNotices({
          launch: {
            lifecycle: 'failed',
            failure: {
              kind: 'refused',
              code: 'agent_session_operation_invalid',
              details: { reason: 'notSignedIn' }
            },
            retry: () => {}
          },
          agentLabel: 'Claude',
          sessionError: null,
          composerError: null,
          setup: { signIn: { signingIn: false, signIn: () => {} }, install: null }
        })}
      />
    </div>
  )
})

export const codexInstall = defineFixture({
  width: 720,
  render: () => (
    <div className="native-chat-appearance p-4">
      <NativeChatComposerNotices
        notices={structuredSessionNotices({
          launch: {
            lifecycle: 'failed',
            failure: {
              kind: 'refused',
              code: 'agent_session_operation_invalid',
              details: { reason: 'cliMissing' }
            },
            retry: () => {}
          },
          agentLabel: 'Codex',
          sessionError: null,
          composerError: null,
          setup: { signIn: null, install: { phase: 'install', busy: false, run: () => {} } }
        })}
      />
    </div>
  )
})

export const antigravitySignIn = defineFixture({
  width: 720,
  render: () => (
    <div className="native-chat-appearance p-4">
      <NativeChatComposerNotices
        notices={structuredSessionNotices({
          launch: {
            lifecycle: 'failed',
            failure: {
              kind: 'refused',
              code: 'agent_session_operation_invalid',
              details: { reason: 'notSignedIn' }
            },
            retry: () => {}
          },
          agentLabel: 'Antigravity',
          sessionError: null,
          composerError: null
        })}
      />
    </div>
  )
})

export const conversationInOtherFolder = defineFixture({
  width: 720,
  render: () => (
    <div className="native-chat-appearance p-4">
      <NativeChatComposerNotices
        notices={structuredSessionNotices({
          launch: {
            lifecycle: 'failed',
            failure: {
              kind: 'refused',
              code: 'agent_session_identity_required',
              details: { reason: 'transcriptUnreadable', otherFolder: true }
            },
            retry: () => {}
          },
          agentLabel: 'Claude',
          sessionError: null,
          composerError: null
        })}
      />
    </div>
  )
})

function codexTooOld(phase: 'idle' | 'running' | 'failed', hostName = 'this computer') {
  return defineFixture({
    width: 720,
    render: () => (
      <div className="native-chat-appearance p-4">
        <NativeChatComposerNotices
          notices={structuredSessionNotices({
            launch: {
              lifecycle: 'failed',
              failure: {
                kind: 'refused',
                code: 'agent_session_operation_invalid',
                details: {
                  agentInstallation: {
                    agent: 'codex',
                    installedVersion: '0.130.0',
                    minimumVersion: '0.136.0'
                  }
                }
              },
              retry: () => {}
            },
            agentLabel: 'Codex',
            hostName,
            sessionError: null,
            composerError: null,
            setup: {
              signIn: null,
              install: null,
              update: {
                update: null,
                run:
                  phase === 'running'
                    ? { phase }
                    : phase === 'failed'
                      ? { phase, output: 'npm error code EACCES', finishedAt: 0 }
                      : null,
                start: async () => false,
                openFailure: () => {}
              }
            }
          })}
        />
      </div>
    )
  })
}

export const codexTooOldUpdate = codexTooOld('idle')
export const codexTooOldUpdating = codexTooOld('running')
export const codexTooOldUpdateFailed = codexTooOld('failed')
export const codexTooOldOnServer = codexTooOld('idle', 'Build server')

// Seeded, synthetic: a Retry refused because its two images are still in another chat's draft.
const heldElsewhere = (label = 'Fix login redirect') =>
  nativeChatHeldElsewhereNotice(
    { count: 2, ownerSessionId: 'fixture-owner' },
    { label, open: () => {} },
    () => {}
  )
const LONG_TITLE = 'Investigate flaky checkout redirect after the payment provider timeout'

const heldFixture = (width: number, notice: ReturnType<typeof heldElsewhere>) =>
  defineFixture({
    width,
    render: () => (
      <div className="native-chat-appearance p-4">
        <NativeChatComposerNotices notices={[notice]} />
      </div>
    )
  })

export const heldInOtherChat = heldFixture(720, heldElsewhere())
export const heldInOtherChatNarrow = heldFixture(360, heldElsewhere())
export const heldInOtherChatLongTitle = heldFixture(720, heldElsewhere(LONG_TITLE))
export const heldInOtherChatLongTitleNarrow = heldFixture(360, heldElsewhere(LONG_TITLE))
// No open chat to name (a pending creation's draft holds it), and files spread over two chats.
export const heldInAnotherChatNarrow = heldFixture(
  360,
  nativeChatHeldElsewhereNotice({ count: 1 }, null, () => {})
)
export const heldInOtherChatsNarrow = heldFixture(
  360,
  nativeChatHeldElsewhereNotice({ count: 3, severalChats: true }, null, () => {})
)

export const heldAndGoneNarrow = heldFixture(
  360,
  nativeChatHeldElsewhereRecoveryNotice(heldElsewhere(), ['orca-browser-file:fixture/missing.png'])
)
export const heldAndGone = heldFixture(
  720,
  nativeChatHeldElsewhereRecoveryNotice(heldElsewhere(), ['orca-browser-file:fixture/missing.png'])
)
