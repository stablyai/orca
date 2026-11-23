import { useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { nativeChatAppearanceStyle } from '../appearance/native-chat-appearance-style'
import { NativeChatDock } from '../pane/dock/NativeChatDock'
import { NativeChatQuestionCard } from '../prompts/NativeChatQuestionCard'
import { NativeChatQueuedMessageList } from './NativeChatQueuedMessageList'
import { NativeChatComposer } from '../composer/NativeChatComposer'
import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'
import type { QueuedMessageCard } from '../../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import type { AgentMessageSource } from '../../../../../shared/agent-session/journal/agent-session-message-source'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../../../shared/agent-session/requests/agent-session-queued-message-wire'
import type { AskPrompt } from '../../../../../shared/native-chat/input/questions/native-chat-ask-types'

const sender = (name: string): AgentMessageSource => ({
  kind: 'agent',
  senders: [
    {
      party: { address: name, terminalHandle: null, orcaSessionId: null },
      name
    }
  ],
  orchestration: null
})

const MESSAGES: Pick<QueuedMessageCard, 'text' | 'from'>[] = [
  {
    text: 'Draft 3 is published with the interactive mock; the share link has the new states.',
    from: sender('Docs helper')
  },
  { text: 'Can we ship the Slack card this week?' },
  {
    text: 'The build stopped without a report after the second step.',
    from: sender('Code reviewer')
  },
  { text: 'Also check the light theme before you send the mockup.' },
  {
    text: 'Review passed, with one follow-up about the placeholder.',
    from: sender('Code reviewer')
  },
  { text: 'When that is done, rebase on main and push.' }
]

function cards(count: number, failedIndex = -1): QueuedMessageCard[] {
  return MESSAGES.slice(0, count).map((message, i) => ({
    messageId: `m${i}`,
    position: i,
    state: 'waiting',
    hold: i === failedIndex ? 'paused' : 'turn',
    ...(i === failedIndex ? { pausedReason: QUEUED_MESSAGE_PAUSED_SEND_FAILED } : {}),
    ...message
  }))
}

const noop = async (): Promise<void> => {}

function controller(
  list: QueuedMessageCard[],
  paused = false
): StructuredAgentSessionQueuedMessagesController {
  return {
    cards: list,
    queueCapable: true,
    clearCapable: true,
    pause: paused ? { reason: 'user' } : null,
    resume: async () => true,
    clear: async () => true,
    queuePending: null,
    pending: () => null,
    steer: noop,
    remove: noop,
    editCapable: true,
    editor: undefined,
    edit: noop,
    steerHead: undefined,
    isWorking: true
  }
}

const QUESTIONS: AskPrompt['questions'] = [
  {
    header: 'Card content',
    question: 'When a bot asks from a Slack thread, what should the Slack card show?',
    multiSelect: false,
    options: [
      {
        label: 'Show question (Recommended)',
        description: 'Show the question and its options in the thread.'
      },
      { label: 'Generic notice only', description: 'Always show a generic notice with a link.' }
    ]
  },
  {
    header: 'No origin',
    question: 'What should happen when the ask has no Slack origin?',
    multiSelect: false,
    options: [
      { label: "Post to the owner's DM (Recommended)", description: 'The owner gets the card.' },
      { label: 'Stay in Orca only', description: 'No Slack card at all.' }
    ]
  },
  {
    header: 'Who answers',
    question: 'Who can answer from Slack?',
    multiSelect: true,
    options: [
      { label: 'The owner', description: "Others see the card but can't pick." },
      { label: 'Anyone in the thread', description: 'First answer wins.' },
      { label: "People on the bot's list", description: 'Uses the Who can ask list.' }
    ]
  },
  {
    header: 'Queued answer',
    question: 'If the person already answered in Orca, what does the Slack card show?',
    multiSelect: false,
    options: [
      { label: 'Answered in Orca', description: 'The card updates in place.' },
      { label: 'Leave it as is', description: 'It keeps its buttons until it expires.' }
    ]
  }
]

// Worst-case words: a question that wraps for several lines in the narrowest pane, and long options.
const LONG_QUESTION: AskPrompt['questions'][number] = {
  header: 'Notification rules for long-running background jobs',
  question:
    'When a background job that was started from a thread finishes after the person has already left the thread, and the job produced files that need a review, where should the result and its review request be posted so nobody misses it?',
  multiSelect: false,
  options: [
    {
      label:
        'Post the result in the original thread and mention the person who started it (Recommended)',
      description:
        'The thread keeps the whole history, and the mention reaches the person wherever they are.'
    },
    {
      label: 'Send the result to the person directly and link back to the thread',
      description: 'Private first; the thread only gets a short note.'
    }
  ]
}

function Pane({
  queue,
  question,
  height = 760
}: {
  queue: StructuredAgentSessionQueuedMessagesController
  question?: AskPrompt
  height?: number
}) {
  return (
    <div
      data-native-chat-root="true"
      className="native-chat-appearance flex flex-col bg-chat-pane"
      style={{ ...nativeChatAppearanceStyle({}), height }}
    >
      <div className="flex min-h-[calc(var(--spacing)*20)] flex-1 flex-col justify-end overflow-hidden p-4 text-sm text-muted-foreground [[data-native-chat-dock-fit~=transcript]_&]:min-h-0">
        Here is the draft for the Slack card.
      </div>
      <NativeChatDock>
        <NativeChatQueuedMessageList controller={queue} chatWorktreeId={null} />
        {question ? (
          <NativeChatQuestionCard
            prompt={question}
            onAnswer={() => {}}
            onCancel={() => {}}
            onCollapse={() => {}}
          />
        ) : (
          <NativeChatComposer
            terminalTabId="queue-fixture-tab"
            paneKey="queue-fixture-pane"
            targetPtyId={null}
            agent="claude"
          />
        )}
      </NativeChatDock>
    </div>
  )
}

export const sixQueuedWithQuestion = defineFixture({
  width: 560,
  render: () => <Pane queue={controller(cards(6))} question={{ questions: QUESTIONS }} />
})

export const queuedOnComposer = defineFixture({
  width: 560,
  render: () => <Pane queue={controller(cards(3))} height={700} />
})

export const paused = defineFixture({
  width: 560,
  render: () => <Pane queue={controller(cards(3), true)} height={700} />
})

export const failed = defineFixture({
  width: 560,
  render: () => <Pane queue={controller(cards(3, 1))} height={700} />
})

export const narrow = defineFixture({
  width: 380,
  render: () => <Pane queue={controller(cards(6))} question={{ questions: QUESTIONS }} />
})

export const stepTwoOfFour = defineFixture({
  width: 560,
  render: () => <Pane queue={controller(cards(2))} question={{ questions: QUESTIONS }} />,
  interact: async (frame) => {
    frame.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')[0]?.click()
    await new Promise((resolve) => setTimeout(resolve, 600))
  }
})

export const multiSelect = defineFixture({
  width: 560,
  render: () => (
    <Pane queue={controller(cards(1))} question={{ questions: [QUESTIONS[2]!] }} height={640} />
  ),
  interact: async (frame) => {
    const rows = frame.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')
    rows[0]?.click()
    await new Promise(requestAnimationFrame)
    rows[2]?.click()
    await new Promise(requestAnimationFrame)
  }
})

export const shortPane = defineFixture({
  width: 560,
  render: () => (
    <Pane queue={controller(cards(6))} question={{ questions: QUESTIONS }} height={420} />
  )
})

export const tinyPane = defineFixture({
  width: 560,
  render: () => (
    <Pane queue={controller(cards(6))} question={{ questions: QUESTIONS }} height={312} />
  )
})

// Drives the dock's fit from the page (window.__dockFitLab) to measure levels in real layout.
function FitLab() {
  const [height, setHeight] = useState(700)
  const [mounted, setMounted] = useState(true)
  Object.assign(window, { __dockFitLab: { setHeight, setMounted } })
  if (!mounted) {
    return <div data-native-chat-root="true" style={{ height }} />
  }
  return (
    <div
      data-native-chat-root="true"
      className="native-chat-appearance flex flex-col bg-chat-pane"
      style={{ ...nativeChatAppearanceStyle({}), height }}
    >
      <div className="flex min-h-[calc(var(--spacing)*20)] flex-1 flex-col justify-end overflow-hidden p-4 text-sm text-muted-foreground [[data-native-chat-dock-fit~=transcript]_&]:min-h-0">
        Here is the draft for the Slack card.
      </div>
      <NativeChatDock>
        <NativeChatQueuedMessageList controller={controller(cards(6))} chatWorktreeId={null} />
        <NativeChatQuestionCard
          prompt={{ questions: QUESTIONS }}
          onAnswer={() => {}}
          onCancel={() => {}}
        />
        {/* The composer's box and editor classes, so its fit cap behaves as in the app. */}
        <div className="shrink-0 bg-chat-pane px-3 pt-2 pb-4 sm:px-4">
          <div
            data-native-chat-dock-pinned
            className="rounded-xl border border-chat-composer-border bg-chat-composer-surface p-1.5 shadow-xs"
          >
            <div
              contentEditable
              suppressContentEditableWarning
              data-lab-editor
              className="scrollbar-sleek min-h-12 max-h-[calc(8lh+0.5rem)] w-full overflow-y-auto bg-transparent px-2 py-1 text-sm outline-none [[data-native-chat-dock-fit~=composer]_[data-native-chat-dock]:has([data-native-chat-question-card])_&]:max-h-[calc(3lh+0.5rem)]"
            />
            <div className="h-8" />
          </div>
        </div>
      </NativeChatDock>
    </div>
  )
}

export const fitLab = defineFixture({ width: 560, render: () => <FitLab /> })

// The app's own composer under the queue (and an async question), as a structured chat shows them.
function RealComposerPane({ question }: { question: boolean }) {
  return (
    <div
      data-native-chat-root="true"
      className="native-chat-appearance flex flex-col bg-chat-pane"
      style={{ ...nativeChatAppearanceStyle({}), height: question ? 900 : 520 }}
    >
      <div className="flex min-h-[calc(var(--spacing)*20)] flex-1 flex-col justify-end overflow-hidden p-4 text-sm text-muted-foreground [[data-native-chat-dock-fit~=transcript]_&]:min-h-0">
        Here is the draft for the Slack card.
      </div>
      <NativeChatDock>
        <NativeChatQueuedMessageList controller={controller(cards(3))} chatWorktreeId={null} />
        {question ? (
          <NativeChatQuestionCard
            prompt={{ questions: QUESTIONS.slice(0, 2) }}
            onAnswer={() => {}}
            onCancel={() => {}}
          />
        ) : null}
        <NativeChatComposer
          terminalTabId="queue-fixture-tab"
          paneKey="queue-fixture-pane"
          targetPtyId={null}
          agent="claude"
        />
      </NativeChatDock>
    </div>
  )
}

export const withRealComposer = defineFixture({
  width: 560,
  render: () => <RealComposerPane question />
})

export const onRealComposer = defineFixture({
  width: 560,
  render: () => <RealComposerPane question={false} />
})

export const wide = defineFixture({
  width: 1100,
  render: () => <Pane queue={controller(cards(6))} question={{ questions: QUESTIONS }} />
})

export const narrowLongQuestion = defineFixture({
  width: 380,
  render: () => (
    <Pane queue={controller(cards(6, 1))} question={{ questions: [LONG_QUESTION, ...QUESTIONS] }} />
  )
})

export const narrowTinyLongQuestion = defineFixture({
  width: 380,
  render: () => (
    <Pane
      queue={controller(cards(6))}
      question={{ questions: [LONG_QUESTION, ...QUESTIONS] }}
      height={312}
    />
  )
})

// Where focus lands when a focused "+N more" goes away: the pane grows, or the question closes.
type FocusHandoffControls = {
  setHeight: (height: number) => void
  setQuestion: (on: boolean) => void
}
const focusHandoff: { controls?: FocusHandoffControls } = {}

function FocusHandoffPane({
  height: initialHeight,
  question: initialQuestion
}: {
  height: number
  question: boolean
}) {
  const [height, setHeight] = useState(initialHeight)
  const [question, setQuestion] = useState(initialQuestion)
  focusHandoff.controls = { setHeight, setQuestion }
  return (
    <Pane
      queue={controller(cards(6))}
      question={question ? { questions: QUESTIONS } : undefined}
      height={height}
    />
  )
}

async function handOffFocus(frame: HTMLElement, change: (controls: FocusHandoffControls) => void) {
  const frames = async (count: number) => {
    for (let i = 0; i < count; i++) {
      await new Promise(requestAnimationFrame)
    }
  }
  await frames(4)
  const more = Array.from(frame.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').endsWith('more')
  )
  more?.focus({ focusVisible: true })
  const before = more ? `"${more.textContent}" focused` : 'no "+N more" shown'
  if (focusHandoff.controls) {
    change(focusHandoff.controls)
  }
  await frames(6)
  const active = document.activeElement
  const name = active?.getAttribute('aria-label') || active?.textContent?.trim() || active?.tagName
  const readout = document.createElement('p')
  readout.className = 'px-4 py-2 font-mono text-xs text-foreground'
  readout.textContent = `${before} → after: focus on ${active === document.body ? 'the page (lost)' : `"${name}"`}`
  frame.appendChild(readout)
}

export const focusAfterPaneGrows = defineFixture({
  width: 560,
  render: () => <FocusHandoffPane height={330} question={false} />,
  interact: (frame) => handOffFocus(frame, (controls) => controls.setHeight(760))
})

export const focusAfterQuestionCloses = defineFixture({
  width: 560,
  render: () => <FocusHandoffPane height={760} question />,
  interact: (frame) => handOffFocus(frame, (controls) => controls.setQuestion(false))
})
