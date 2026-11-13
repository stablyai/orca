import '../../appearance/native-chat-appearance.css'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from '../disclosure/native-chat-disclosure-store'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { i18n } from '../../../../i18n/i18n'
import { agentSessionFailureFact } from '../../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../../../shared/agent-session/failures/agent-session-failure-words'
import type { NativeChatTextBlock } from '../../../../../../shared/native-chat/native-chat-types'
import { NativeChatNoticeRow } from './NativeChatNoticeRow'

export const codexFailures = defineFixture({
  width: 440,
  interact: async () => {
    await i18n.changeLanguage('fr')
  },
  render: () => (
    <div className="space-y-3 p-4">
      {(
        [
          'providerUnavailable',
          'providerSafetyStopped',
          'providerResponseFailed',
          'modelUnavailable'
        ] as const
      ).map((kind) => (
        <NativeChatNoticeRow
          key={kind}
          agentName="Codex"
          block={{
            type: 'text',
            tone: 'failure',
            ...agentSessionFailureWords(agentSessionFailureFact(kind), {
              agentName: 'Codex',
              surface: 'row'
            }),
            providerFrame: {
              provider: 'codex',
              kind: 'notification:error',
              payload: {
                head: '{"message":"Provider diagnostic"}',
                byteLength: 33,
                digest: 'fixture',
                truncated: false
              }
            }
          }}
        />
      ))}
    </div>
  )
})

function guardianReview(text: string): NativeChatTextBlock {
  const head = JSON.stringify({ message: text })
  return {
    type: 'text',
    text,
    tone: 'warning',
    providerFrame: {
      provider: 'codex',
      kind: 'notification:guardianWarning',
      payload: { head, byteLength: head.length, digest: 'synthetic', truncated: false }
    }
  }
}

const reviews = [
  guardianReview(
    'Automatic approval review approved (risk: medium, authorization: high): Read-only status query.'
  ),
  guardianReview(
    'Automatic approval review denied (risk: high, authorization: low): Writes outside the workspace.'
  )
]

function GuardianReviewNotices() {
  return (
    <div className="native-chat-appearance space-y-2 p-4">
      {reviews.map((block) => (
        <NativeChatNoticeRow key={block.text} block={block} />
      ))}
    </div>
  )
}

export const guardianReviewsCollapsed = defineFixture({
  width: 720,
  render: () => <GuardianReviewNotices />
})

export const guardianReviewsExpanded = defineFixture({
  width: 720,
  render: () => <GuardianReviewNotices />,
  interact: (frame) => {
    frame.querySelectorAll('summary').forEach((summary) => summary.click())
  }
})

function codexFrame(kind: string, head: string, byteLength = head.length) {
  return {
    provider: 'codex',
    kind,
    payload: { head, byteLength, digest: 'synthetic', truncated: byteLength > head.length }
  }
}

const collapsedNotices: NativeChatTextBlock[] = [
  {
    type: 'text',
    tone: 'warning',
    text: 'Claude hit a temporary problem and is retrying. Retry 2 of 10.\nLast error: HTTP 529 overloaded.',
    failure: {
      kind: 'providerRetrying',
      detail: { text: '{"type":"system","subtype":"api_retry"}', audience: 'log' },
      retry: { error: 'overloaded', status: 529, attempt: 2, maxRetries: 10 }
    }
  },
  {
    type: 'text',
    tone: 'warning',
    text: 'Codex is retrying: stream disconnected before completion.',
    failure: {
      kind: 'providerRetrying',
      detail: { text: 'stream disconnected before completion', audience: 'person' }
    },
    providerFrame: codexFrame(
      'notification:error',
      JSON.stringify({
        error: { message: 'stream disconnected before completion', codexErrorInfo: 'other' },
        willRetry: true,
        threadId: 'synthetic-thread-0000000000000000000000000000000000000000000000000000'
      }).repeat(12),
      48_213
    )
  },
  {
    type: 'text',
    tone: 'warning',
    text: 'Unknown key `experimental_resume` in config.toml; it will be ignored.',
    providerFrame: codexFrame(
      'notification:configWarning',
      '{"summary":"Unknown key `experimental_resume` in config.toml; it will be ignored."}'
    )
  },
  {
    type: 'text',
    tone: 'notice',
    text: '`approval_policy = "on-failure"` is deprecated and will be removed.',
    providerFrame: codexFrame(
      'notification:deprecationNotice',
      '{"summary":"`approval_policy = \\"on-failure\\"` is deprecated and will be removed."}'
    )
  }
]

function CollapsedNotices() {
  return (
    <div className="native-chat-appearance space-y-2 p-4">
      {collapsedNotices.map((block) => (
        <NativeChatNoticeRow key={block.text} block={block} />
      ))}
    </div>
  )
}

export const collapsedNoticesClosed = defineFixture({
  width: 720,
  render: () => <CollapsedNotices />
})

export const collapsedNoticesOpened = defineFixture({
  width: 720,
  render: () => <CollapsedNotices />,
  interact: (frame) => {
    frame.querySelectorAll('summary').forEach((summary) => summary.click())
  }
})

function StoredRetryNotice() {
  const store = useNativeChatDisclosures()
  return (
    <NativeChatDisclosureContext.Provider value={store}>
      <div className="native-chat-appearance p-4">
        <NativeChatNoticeRow
          block={collapsedNotices[1]!}
          disclosureKeys={['synthetic-retry:notice']}
        />
        <output data-disclosure-choice={String(store.read('synthetic-retry:notice'))} />
      </div>
    </NativeChatDisclosureContext.Provider>
  )
}

export const storedRetryNotice = defineFixture({
  width: 720,
  render: () => <StoredRetryNotice />
})
