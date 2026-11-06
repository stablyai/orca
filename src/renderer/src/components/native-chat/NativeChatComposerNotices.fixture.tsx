import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatComposerNotices } from './NativeChatComposerNotices'
import { structuredSessionNotices } from './native-chat-structured-session-notices'
import { structuredAgentSessionReadFailureNotice } from './structured-agent-session-read-failure-notice'

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
