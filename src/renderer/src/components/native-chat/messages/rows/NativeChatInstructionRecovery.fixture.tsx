import { useRef, useState } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { AgentSessionInstructionRecovery } from '../../../../../../shared/agent-session/failures/agent-session-instruction-recovery-failure'
import { agentSessionFailureFact } from '../../../../../../shared/agent-session/failures/agent-session-failure'
import { agentJournalSubmissionKey } from '../../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalSubmission,
  AgentJournalMessageItem,
  AgentJournalRenderItem
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { projectStructuredAgentSessionMessages } from '../../../../../../shared/agent-session/view/structured-agent-session-message-projection'
import { structuredAgentSessionDeliveryNotices } from '../../session/structured/delivery/structured-agent-session-delivery-notices'
import { NativeChatHostSetupContext } from '../../host-access/native-chat-host-setup'
import { MessageRow } from './NativeChatMessageRow'
import { projectQueuedMessageCards } from '../../../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import { NativeChatQueuedMessageCard } from '../../queue/NativeChatQueuedMessageCard'
import { useNativeChatRecoveryFocus } from './use-native-chat-recovery-focus'
import { agentSessionWriteNoticeText } from '../notices/agent-session-write-notice-text'

const WORDS = '[Orca policy] These are my own words. Check the release notes.'
const view = { signIn: { signingIn: false, signIn: () => {} }, install: null }
function RecoveryChat({
  failure: outcome,
  focusProbe = false
}: {
  failure: AgentSessionInstructionRecovery | 'sending' | 'sent' | 'unconfirmed'
  focusProbe?: boolean
}) {
  const [settled, setSettled] = useState(!focusProbe)
  const failure = settled ? outcome : 'sending'
  const [retried, setRetried] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const rejected = failure !== 'sending' && failure !== 'sent' && failure !== 'unconfirmed'
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: WORDS }]
  }
  const a: AgentJournalSubmission = {
    origin: 'client',
    clientMessageId: 'task-a',
    fence: 1,
    payloadFingerprint: 'task-body',
    dispatchState: rejected
      ? 'rejected'
      : failure === 'sending'
        ? 'pending'
        : failure === 'unconfirmed'
          ? 'unknown'
          : 'accepted',
    providerItemId: null,
    reason: null,
    submittedAt: 1_800_000_000_000,
    resolvedAt: rejected ? 1_800_000_010_000 : null,
    ...(rejected
      ? {
          keptAsQueuedMessageId: 'task-a',
          rejection: agentSessionFailureFact('startFailed', {
            instructionRecovery: failure,
            neverReachedAgent: true
          })
        }
      : {})
  }
  const submissions = retried
    ? [
        a,
        {
          ...a,
          clientMessageId: 'task-b',
          queuedMessageId: 'task-a',
          keptAsQueuedMessageId: undefined,
          dispatchState: 'accepted' as const,
          rejection: undefined,
          submittedAt: 1_800_000_011_000
        }
      ]
    : [a]
  const items: AgentJournalRenderItem[] = submissions.map((submission, index) => ({
    itemId: agentJournalSubmissionKey(submission.clientMessageId),
    revision: 1,
    sequence: index + 1,
    observedAt: submission.submittedAt,
    body
  }))
  const messages = projectStructuredAgentSessionMessages(items, [], submissions)
  const notices = structuredAgentSessionDeliveryNotices({
    pending: [],
    submissions,
    agentName: 'Codex',
    startFailures: [],
    onRetry: () => setRetried(true)
  })
  const announcement = useNativeChatRecoveryFocus(root, notices)
  const cards = projectQueuedMessageCards(
    rejected && !retried
      ? [
          {
            messageId: 'task-a',
            position: 0,
            state: 'returned',
            body,
            returnedReason: a.reason,
            returnedRejection: a.rejection
          }
        ]
      : [],
    submissions,
    {}
  )
  return (
    <NativeChatHostSetupContext.Provider value={view}>
      <div
        ref={root}
        data-native-chat-root
        data-native-chat-visible="true"
        className="native-chat-appearance flex flex-col gap-4 p-4"
      >
        {focusProbe ? <textarea aria-label="Fixture draft" /> : null}
        {focusProbe ? <button hidden data-fixture-settle onClick={() => setSettled(true)} /> : null}
        {messages.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            agentName="Codex"
            expandSignal={false}
            onScrollMessageToTop={() => {}}
            deliveryNotice={notices.get(message.id)}
          />
        ))}
        {cards.map((card) => (
          <NativeChatQueuedMessageCard
            key={card.messageId}
            card={card}
            chatWorktreeId={null}
            agentName="Codex"
            showsSteerShortcut={false}
            agentWorking={false}
            onSteer={() => setRetried(true)}
            onDelete={() => {}}
          />
        ))}
        {failure === 'unconfirmed' ? (
          <p>{agentSessionWriteNoticeText(['sendOutcomeLost'])}</p>
        ) : null}
        <span ref={announcement} className="sr-only" role="status" aria-live="polite" />
      </div>
    </NativeChatHostSetupContext.Provider>
  )
}

export const sending = defineFixture({
  width: 640,
  render: () => <RecoveryChat failure="sending" />
})
export const timeout = defineFixture({
  width: 640,
  render: () => <RecoveryChat failure="timeout" />
})
export const pending = defineFixture({
  width: 640,
  render: () => <RecoveryChat failure="pending" />
})
export const commit = defineFixture({ width: 640, render: () => <RecoveryChat failure="commit" /> })
export const unsupported = defineFixture({
  width: 640,
  render: () => <RecoveryChat failure="unsupported" />
})
export const unknown = defineFixture({
  width: 640,
  render: () => <RecoveryChat failure="unknown" />
})
export const sent = defineFixture({ width: 640, render: () => <RecoveryChat failure="sent" /> })
export const rowRetry = defineFixture({
  width: 640,
  render: () => <RecoveryChat failure="timeout" />,
  interact: async (frame) => {
    frame.querySelector<HTMLButtonElement>('button[data-native-chat-retry]')?.click()
  }
})

async function settleFocusProbe(frame: HTMLElement): Promise<void> {
  frame.querySelector<HTMLTextAreaElement>('textarea')?.focus()
  frame.querySelector<HTMLButtonElement>('[data-fixture-settle]')?.click()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

export const focusPending = defineFixture({
  width: 640,
  render: () => <RecoveryChat failure="pending" focusProbe />,
  interact: settleFocusProbe
})

export const focusUnconfirmed = defineFixture({
  width: 640,
  render: () => <RecoveryChat failure="unconfirmed" focusProbe />,
  interact: settleFocusProbe
})
