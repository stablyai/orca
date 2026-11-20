import { defineFixture } from '../../component-fixtures/component-fixture'
import { stubBots } from '../../component-fixtures/fixture-bots'
import type { Bot } from '../../../../shared/bot-types'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { NativeChatVisualOwnerContext } from './media/visuals/native-chat-visual-owner'
import { NativeChatPaneHeader } from './pane/actions/NativeChatPaneHeader'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
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
    chatSessionId: 'fixture',
    createdAt: 1,
    updatedAt: 1
  }
}

const OWNER = {
  target: { kind: 'local' as const },
  sessionId: 'fixture',
  worktreeId: folderWorkspaceKey('fw-reviewer')
}

const tab: Tab = {
  id: 'fixture-intro-tab',
  entityId: OWNER.sessionId,
  worktreeId: OWNER.worktreeId,
  executionHostId: 'local',
  groupId: 'fixture-group',
  contentType: 'agent-session',
  agentSessionAgent: 'claude',
  label: 'Home',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
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
      <div className="native-chat-appearance relative flex h-[460px] flex-col bg-background">
        <NativeChatPaneHeader
          tabId={tab.id}
          worktreeId={OWNER.worktreeId}
          groupId={tab.groupId}
          nativeChat={{ sessionId: OWNER.sessionId, agent: 'claude' }}
          focused
          colorScheme={undefined}
        />
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

const SHORT = botNamed('Atlas')
const LONG = botNamed('Engineering Reviewer for the Payments and Billing Platform Team')
const GREETING = 'Hi! What should I review first?'
const OLD_GREETING =
  "Hi, I'm Atlas. Alex shared the link that set me up to run technical design and code review for your engineering bots: I chair the review councils, give evidence-backed verdicts on PRs, and keep a single record of findings. What should I review first?"

function introScene(width: number, bot: Bot, greeting = GREETING) {
  return defineFixture({
    width,
    store: {
      workspaceSessionReady: true,
      unifiedTabsByWorktree: { [OWNER.worktreeId]: [tab] }
    },
    setup: () => stubBots([bot]),
    render: () => <Chat intro={greeting} />
  })
}

export const intro = introScene(640, SHORT)
export const introNarrowLongName = introScene(300, LONG)
export const introLongGreeting = introScene(640, SHORT, OLD_GREETING)
