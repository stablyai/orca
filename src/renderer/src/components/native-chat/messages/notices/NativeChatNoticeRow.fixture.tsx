import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { i18n } from '../../../../i18n/i18n'
import { agentSessionFailureFact } from '../../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../../../shared/agent-session/failures/agent-session-failure-words'
import type { NativeChatTextBlock } from '../../../../../../shared/native-chat/native-chat-types'
import { NativeChatNoticeRow } from './NativeChatNoticeRow'
import {
  NativeChatOrcaStopContext,
  type NativeChatOrcaStopView
} from './native-chat-orca-stop-context'
import { NativeChatUsageLimitActionsContext } from '../../usage/NativeChatUsageLimitActions'
import { ProviderAccountChatButton } from '../../../status-bar/ProviderAccountChatButton'

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

const USAGE_LIMIT_RESET = new Date(2026, 10, 9, 15, 40).getTime()

const USAGE_LIMIT_ACTIONS = {
  account: <ProviderAccountChatButton provider="claude" target={{ kind: 'local' }} disabled />,
  handOff: () => {},
  disabled: false
}

const USAGE_LIMIT_STOP_VIEWS: NativeChatOrcaStopView[] = (
  [
    { kind: 'off', resetsAt: USAGE_LIMIT_RESET },
    { kind: 'scheduled', resetsAt: USAGE_LIMIT_RESET, cancel: () => {} },
    { kind: 'cancelled', resetsAt: USAGE_LIMIT_RESET }
  ] as const
).map((usageLimitAutoContinue) => ({
  hostLabel: null,
  remoteHost: false,
  continueAvailable: false,
  offeredTurnItemId: null,
  continueNow: () => {},
  usageLimitTurnItemId: 'cut-turn',
  usageLimitAutoContinue,
  continueUsageLimit: () => {}
}))

export const usageLimit = defineFixture({
  width: 560,
  render: () => (
    <NativeChatUsageLimitActionsContext.Provider value={USAGE_LIMIT_ACTIONS}>
      <div className="native-chat-appearance space-y-3 p-4">
        {USAGE_LIMIT_STOP_VIEWS.map((view) => (
          <NativeChatOrcaStopContext.Provider key={view.usageLimitAutoContinue?.kind} value={view}>
            <NativeChatNoticeRow
              agentName="Claude"
              block={{
                type: 'text',
                tone: 'warning',
                text: 'Claude hit its usage limit.',
                usageLimitTurnItemId: 'cut-turn',
                failure: { kind: 'usageLimitReached', usageLimit: { resetsAt: USAGE_LIMIT_RESET } }
              }}
            />
          </NativeChatOrcaStopContext.Provider>
        ))}
      </div>
    </NativeChatUsageLimitActionsContext.Provider>
  )
})
