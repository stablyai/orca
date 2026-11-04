import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatContextUsageRing } from './NativeChatContextUsageRing'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import { nativeChatAppearanceStyle } from './native-chat-appearance-style'
import { useState } from 'react'
import { NativeChatFileLinkExistenceContext } from './native-chat-file-link-existence'
import type { NativeChatQuestionCardProps } from './NativeChatQuestionCard'
import { NativeChatStructuredAsyncQuestion } from './NativeChatStructuredAsyncQuestion'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'

function QuestionControls({
  invertedAccent = false,
  question = 'Where should this run?',
  description = 'Use this computer.',
  onLinkClick
}: {
  invertedAccent?: boolean
  question?: string
  description?: string
  onLinkClick?: NativeChatQuestionCardProps['onLinkClick']
}) {
  return (
    <div
      className="native-chat-appearance bg-chat-canvas p-4"
      style={{
        ...nativeChatAppearanceStyle({}),
        ...(invertedAccent
          ? { '--accent': 'var(--foreground)', '--accent-foreground': 'var(--background)' }
          : {})
      }}
    >
      <NativeChatContextUsageRing
        usage={{
          usedTokens: 42_000,
          windowTokens: 200_000,
          percentage: 21,
          estimated: false,
          rows: []
        }}
      />
      <NativeChatQuestionCard
        prompt={{
          questions: [
            {
              question,
              multiSelect: true,
              options: [
                { label: 'Local', description },
                { label: 'Remote', description: 'Use the connected host.' }
              ]
            }
          ]
        }}
        onLinkClick={onLinkClick}
        onAnswer={() => {}}
        onCancel={() => {}}
      />
    </div>
  )
}

export const standard = defineFixture({ width: 560, render: () => <QuestionControls /> })

export const invertedAccent = defineFixture({
  width: 560,
  render: () => <QuestionControls invertedAccent />,
  interact: (frame) => frame.querySelector<HTMLButtonElement>('button[aria-pressed]')?.click()
})

export const multiline = defineFixture({
  width: 560,
  render: () => (
    <QuestionControls
      question={
        'Where should this run?\n\n- Local keeps changes on this computer\n- Remote uses the host'
      }
      description={'Use this computer.\nKeeps the current workspace.'}
    />
  )
})

function PendingAsyncQuestion() {
  const [pending, setPending] = useState(false)
  const title = 'What would you most like to do this weekend?'
  const ask: AgentJournalRenderItem = {
    itemId: 'weekend-question',
    sequence: 1,
    revision: 0,
    observedAt: 1,
    body: {
      kind: 'message',
      role: 'assistant',
      blocks: [
        {
          type: 'tool-call',
          name: 'request_user_input_async',
          input: {
            questions: [
              {
                title,
                options: [
                  'Relax at home',
                  'Get outside',
                  'See friends or family',
                  'Work on a project'
                ]
              }
            ]
          }
        }
      ]
    }
  }
  const answer: AgentJournalRenderItem = {
    itemId: agentJournalSubmissionKey('weekend-answer'),
    sequence: 2,
    revision: 0,
    observedAt: 2,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: `> ${title}\n\nGet outside` }]
    }
  }
  const submission: AgentJournalSubmission = {
    clientMessageId: 'weekend-answer',
    fence: 1,
    payloadFingerprint: 'weekend-answer',
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: 2,
    resolvedAt: null,
    handoverRecorded: true
  }
  return (
    <div
      className="native-chat-appearance bg-chat-canvas p-4"
      style={nativeChatAppearanceStyle({})}
    >
      <NativeChatStructuredAsyncQuestion
        paneKey="weekend-question"
        sourceKey="fixture/session/epoch"
        sourceScope="journal/session/epoch"
        session={{
          readPhase: 'ready',
          messages: projectStructuredAgentSessionMessages(
            pending ? [ask, answer] : [ask],
            [],
            pending ? [submission] : []
          )
        }}
        send={(_text, _images, request) => {
          setPending(true)
          queueMicrotask(() => request?.onSettled?.('recorded'))
          return true
        }}
      />
    </div>
  )
}

export const pendingAnswer = defineFixture({
  width: 560,
  render: () => <PendingAsyncQuestion />,
  interact: async (frame) => {
    const option = [...frame.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(
      (button) => button.textContent?.includes('Get outside')
    )!
    option.click()
    await new Promise(requestAnimationFrame)
    ;[...frame.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Submit')
      ?.click()
    await new Promise(requestAnimationFrame)
  }
})

const linkSnapshot = {
  check: (link: { pathText: string }) => link.pathText === '/tmp/question-mock.html',
  peek: () => false
}

const linkExistence = {
  watch: () => ({ subscribe: () => () => {}, getSnapshot: () => linkSnapshot }),
  recheck: () => {}
}

export const links = defineFixture({
  width: 720,
  render: () => (
    <NativeChatFileLinkExistenceContext.Provider value={linkExistence}>
      <QuestionControls
        onLinkClick={(event) => event.preventDefault()}
        question={
          'For the reset time and Continue now action, the proposed surfaces are shown in /tmp/question-mock.html. See [the proposal](https://example.com/proposal).\nWhich surface should carry it?'
        }
      />
    </NativeChatFileLinkExistenceContext.Provider>
  )
})
