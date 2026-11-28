import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { i18n } from '../../../../i18n/i18n'
import { agentSessionFailureFact } from '../../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../../../shared/agent-session/failures/agent-session-failure-words'
import type { NativeChatTextBlock } from '../../../../../../shared/native-chat/native-chat-types'
import { NativeChatNoticeRow } from './NativeChatNoticeRow'
import { AGENT_SESSION_TURN_NOTICE_PRESENTATION } from '../../../../../../shared/agent-session/journal/agent-session-turn-notice'
import {
  AGENT_ACCOUNT_SWITCH_FRAME_KIND,
  agentAccountSwitchText,
  type AgentAccountSwitchNotice
} from '../../../../../../shared/native-chat/transcript/notices/agent-account-switch-notice'

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

function ContextNotes(): React.JSX.Element {
  const at = Date.parse('2026-11-14T17:55:00Z')
  const notes: NativeChatTextBlock[] = [
    { type: 'text', text: '', botContext: { botId: 'b1', changed: ['memory'] } },
    { type: 'text', text: '', botContext: { botId: 'b1', changed: ['soul'] } },
    { type: 'text', text: '', botContext: { botId: 'b1', changed: ['soul', 'memory'] } }
  ]
  return (
    <div className="flex flex-col gap-1 bg-chat-pane p-4">
      {notes.map((block, index) => (
        <NativeChatNoticeRow
          key={block.botContext?.changed.join()}
          block={block}
          timestamp={at + index * 60_000}
        />
      ))}
    </div>
  )
}

export const contextNotes = defineFixture({ width: 600, render: () => <ContextNotes /> })

export const contextNotesNarrow = defineFixture({ width: 340, render: () => <ContextNotes /> })

function AccountSwitchNote({ notice }: { notice: AgentAccountSwitchNotice }): React.JSX.Element {
  const head = JSON.stringify(notice)
  // The row the host writes into a chat about its saved account.
  const block: NativeChatTextBlock = {
    type: 'text',
    text: agentAccountSwitchText(notice),
    tone: 'notice',
    presentation: AGENT_SESSION_TURN_NOTICE_PRESENTATION,
    providerFrame: {
      provider: 'orca',
      kind: AGENT_ACCOUNT_SWITCH_FRAME_KIND,
      payload: { head, byteLength: head.length, digest: 'synthetic', truncated: false }
    }
  }
  return (
    <div className="bg-chat-pane p-4">
      <NativeChatNoticeRow block={block} agentName="Antigravity" />
    </div>
  )
}

// A chat still running a turn when the account was switched.
export const accountSwitch = defineFixture({
  width: 600,
  render: () => (
    <AccountSwitchNote notice={{ from: 'personal@example.com', to: 'work@example.com' }} />
  )
})

// A chat that couldn't start on the selected account.
export const accountNotMoved = defineFixture({
  width: 600,
  render: () => (
    <AccountSwitchNote
      notice={{
        to: 'work@example.com',
        reason:
          "Checking agy's login for the selected account could ask for keychain access, so it was left as it is."
      }}
    />
  )
})
