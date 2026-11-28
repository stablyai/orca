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

function cliInstall(agentLabel: string, phase: 'install' | 'recheck' = 'install') {
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
                details: { reason: 'cliMissing' }
              },
              retry: () => {}
            },
            agentLabel,
            sessionError: null,
            composerError: null,
            setup: { signIn: null, install: { phase, busy: false, run: () => {} } }
          })}
        />
      </div>
    )
  })
}

export const codexInstall = cliInstall('Codex')
export const antigravityInstall = cliInstall('Antigravity')
export const antigravityInstallRecheck = cliInstall('Antigravity', 'recheck')

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

const TOO_OLD = {
  codex: { label: 'Codex', installedVersion: '0.130.0', minimumVersion: '0.136.0' },
  antigravity: { label: 'Antigravity', installedVersion: '1.5.2', minimumVersion: '1.5.5' }
} as const

function cliTooOld(
  phase: 'idle' | 'running' | 'failed',
  hostName = 'this computer',
  agent: keyof typeof TOO_OLD = 'codex'
) {
  const { label, installedVersion, minimumVersion } = TOO_OLD[agent]
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
                details: { agentInstallation: { agent, installedVersion, minimumVersion } }
              },
              retry: () => {}
            },
            agentLabel: label,
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

export const codexTooOldUpdate = cliTooOld('idle')
export const codexTooOldUpdating = cliTooOld('running')
export const codexTooOldUpdateFailed = cliTooOld('failed')
export const codexTooOldOnServer = cliTooOld('idle', 'Build server')
export const antigravityTooOldUpdate = cliTooOld('idle', 'this computer', 'antigravity')
