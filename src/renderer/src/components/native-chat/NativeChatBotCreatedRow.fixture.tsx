import { defineFixture } from '../../component-fixtures/component-fixture'
import { stubBots } from '../../component-fixtures/fixture-bots'
import type { Bot } from '../../../../shared/bot-types'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { NativeChatVisualOwnerContext } from './media/visuals/native-chat-visual-owner'
import { NativeChatMessageList } from './NativeChatMessageList'
import type { NativeChatLiveSession } from './session/terminal/read/native-chat-live-session-contract'

function botNamed(name: string): Bot {
  return {
    id: 'bot-reviewer',
    name,
    hostId: 'local',
    folder: 'reviewer',
    folderWorkspaceId: 'fw-reviewer',
    agent: 'claude',
    avatar: null,
    paused: false,
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId: null,
    createdAt: 1,
    updatedAt: 1
  }
}

const OWNER = {
  target: { kind: 'local' as const },
  sessionId: 'fixture',
  worktreeId: folderWorkspaceKey('fw-reviewer')
}

const STARTED_AT = new Date().setHours(8, 50, 0, 0)

function text(
  id: string,
  role: NativeChatMessage['role'],
  body: string,
  minutes: number,
  extra: Partial<NativeChatMessage> = {}
): NativeChatMessage {
  return {
    id,
    role,
    source: 'transcript',
    timestamp: STARTED_AT + minutes * 60_000,
    blocks: [{ type: 'text', text: body }],
    ...extra
  }
}

function messages(intro: string): NativeChatMessage[] {
  return [
    text('k1', 'user', 'Orca: you were just created.', 0, { orcaNotice: 'bot-created' }),
    text('r1', 'reasoning', 'Greet the owner and ask.', 0.02),
    text('a1', 'assistant', intro, 0.05),
    text('u2', 'user', 'Review the open PRs on the parser.', 2),
    text(
      'a2',
      'assistant',
      'Two PRs are open; the first one drops an error case. Details below.',
      3
    )
  ]
}

function Chat({ intro }: { intro: string }): React.JSX.Element {
  const session: NativeChatLiveSession = {
    messages: messages(intro),
    agent: 'claude',
    sessionId: 'fixture',
    status: 'ready',
    readPhase: 'ready',
    hasMore: false,
    loadingEarlier: false,
    olderHistoryGeneration: 0,
    loadEarlier: async () => 'applied'
  }
  return (
    <NativeChatVisualOwnerContext.Provider value={OWNER}>
      <div className="native-chat-appearance flex h-[460px] flex-col bg-background">
        <NativeChatMessageList
          session={session}
          isWorking={false}
          expandSignal={false}
          settledTurns={
            new Map([
              ['k1', { startedAt: 0, workedSeconds: 3 }],
              ['u2', { startedAt: 0, workedSeconds: 41 }]
            ])
          }
        />
      </div>
    </NativeChatVisualOwnerContext.Provider>
  )
}

const SHORT = botNamed('Eng - Reviewer')
const LONG = botNamed('Engineering Reviewer for the Payments and Billing Platform Team')
const GREETING = 'Hi! What should I review first?'
const OLD_GREETING =
  "Hi, I'm Eng - Reviewer. Alex shared the link that set me up to run technical design and code review for your engineering bots: I chair the review councils, give evidence-backed verdicts on PRs, and keep a single record of findings. What should I review first?"

// A new bot's Chat: its pill header, start time, one-line greeting, then a later turn as usual.
export const intro = defineFixture({
  width: 640,
  setup: () => stubBots([SHORT]),
  render: () => <Chat intro={GREETING} />
})

// The narrowest pane with the longest name: the pill truncates it.
export const introNarrowLongName = defineFixture({
  width: 300,
  setup: () => stubBots([LONG]),
  render: () => <Chat intro={GREETING} />
})

// The greeting a bot from a shared link gave before its first-run rules were tightened.
export const introLongGreeting = defineFixture({
  width: 640,
  setup: () => stubBots([SHORT]),
  render: () => <Chat intro={OLD_GREETING} />
})
