import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatComposerNotices } from './NativeChatComposerNotices'
import { structuredSessionNotices } from '../../messages/notices/native-chat-structured-session-notices'
import { structuredAgentSessionReadFailureNotice } from '../../messages/notices/structured-agent-session-read-failure-notice'

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
