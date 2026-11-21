import { useState } from 'react'
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

const sideTab: Tab = { ...tab, id: 'fixture-side-tab', entityId: 'fixture-side', label: 'Side' }
const SIDE_OWNER = { ...OWNER, sessionId: sideTab.entityId }

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

/** A later page of a long chat, scrolled to its top while older messages load or fail to. */
function laterMessages(): NativeChatMessage[] {
  return [
    text('u7', 'user', 'Did the parser fix land?', 30),
    text('a7', 'assistant', 'Yes. Both PRs merged and the error case has a test now.', 31),
    text('u8', 'user', 'Great, what is next on the list?', 40)
  ]
}

/** Holds the last page until the scene has scrolled and measured; each render gets a fresh gate. */
let lastPageGate = Promise.withResolvers<void>()

/** A chat whose last older page is still to load. */
function longMessages(length = 24): NativeChatMessage[] {
  return Array.from({ length }, (_, index) =>
    text(
      `l${index}`,
      index % 2 === 0 ? 'user' : 'assistant',
      `Message ${index + 1}: notes on the parser review.`,
      60 + index
    )
  )
}

function oldestMessages(): NativeChatMessage[] {
  return [
    text('o1', 'user', 'Orca: the oldest page.', 0),
    text('o2', 'assistant', 'This is where the chat began.', 1)
  ]
}

/** `emptyLastPage`: a short chat whose last read finds nothing older. */
type OlderHistory = 'loading' | 'failed' | 'lastPage' | 'emptyLastPage'

function Chat({
  intro,
  side = false,
  olderHistory
}: {
  intro: string
  side?: boolean
  olderHistory?: OlderHistory
}): React.JSX.Element {
  const chatTab = side ? sideTab : tab
  const [oldest, setOldest] = useState<NativeChatMessage[] | null>(null)
  const empty = olderHistory === 'emptyLastPage'
  const lastPage = olderHistory === 'lastPage' || empty
  const session: NativeChatLiveSession = {
    messages: lastPage
      ? [...(oldest ?? []), ...longMessages(empty ? 8 : 24)]
      : olderHistory
        ? laterMessages()
        : messages(intro),
    agent: 'claude',
    sessionId: chatTab.entityId,
    status: 'ready',
    readPhase: 'ready',
    hasMore: lastPage ? oldest === null : olderHistory !== undefined,
    loadingEarlier: olderHistory === 'loading',
    olderHistoryGeneration: 0,
    loadEarlier: async () => {
      if (olderHistory === 'failed') {
        return 'failed'
      }
      if (lastPage) {
        await lastPageGate.promise
        setOldest(empty ? [] : oldestMessages())
        return 'exhausted'
      }
      return 'applied'
    }
  }
  return (
    <NativeChatVisualOwnerContext.Provider value={side ? SIDE_OWNER : OWNER}>
      <div className="native-chat-appearance relative flex h-[460px] flex-col bg-background">
        <NativeChatPaneHeader
          tabId={chatTab.id}
          worktreeId={OWNER.worktreeId}
          groupId={chatTab.groupId}
          nativeChat={{ sessionId: chatTab.entityId, agent: 'claude' }}
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
        {lastPage ? (
          <div
            data-last-page-measurement=""
            className="absolute bottom-1 left-2 z-30 text-2xs text-muted-foreground"
          />
        ) : null}
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

/** The older-history row sits below the floating pill, never under it. */
function olderHistoryScene(width: number, olderHistory: OlderHistory, side = false) {
  return defineFixture({
    width,
    store: {
      workspaceSessionReady: true,
      unifiedTabsByWorktree: { [OWNER.worktreeId]: [tab, sideTab] }
    },
    setup: () => stubBots([SHORT]),
    render: () => <Chat intro={GREETING} side={side} olderHistory={olderHistory} />,
    // The loading label waits 200ms so quick local reads don't flash it.
    interact: () => new Promise<void>((resolve) => window.setTimeout(resolve, 400))
  })
}

export const intro = introScene(640, SHORT)
export const introNarrowLongName = introScene(300, LONG)
export const introLongGreeting = introScene(640, SHORT, OLD_GREETING)

export const olderHistoryLoading = olderHistoryScene(720, 'loading')
export const olderHistoryLoadingNarrow = olderHistoryScene(300, 'loading')
export const olderHistoryFailed = olderHistoryScene(720, 'failed')
export const olderHistoryFailedNarrow = olderHistoryScene(300, 'failed')
export const sideOlderHistoryLoading = olderHistoryScene(720, 'loading', true)
export const sideOlderHistoryLoadingNarrow = olderHistoryScene(300, 'loading', true)
export const sideOlderHistoryFailed = olderHistoryScene(720, 'failed', true)
export const sideOlderHistoryFailedNarrow = olderHistoryScene(300, 'failed', true)

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => window.requestAnimationFrame(() => resolve()))
const wait = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms))

/** Scrolled up, the last page lands and its row leaves; the rows the reader sees must not move. */
function lastPageScene(width: number, side = false, nearEnd = false) {
  return defineFixture({
    width,
    store: {
      workspaceSessionReady: true,
      unifiedTabsByWorktree: { [OWNER.worktreeId]: [tab, sideTab] }
    },
    setup: () => {
      lastPageGate = Promise.withResolvers<void>()
      stubBots([SHORT])
    },
    render: () => (
      <Chat intro={GREETING} side={side} olderHistory={nearEnd ? 'emptyLastPage' : 'lastPage'} />
    ),
    interact: async (frame) => {
      const scroller = frame.querySelector<HTMLElement>('[data-native-chat-scroll]')!
      await wait(300)
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -900, bubbles: true }))
      if (nearEnd) {
        // A short chat, read just above its end: the row's space leaving would clamp the view.
        scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - 10
      } else {
        // Near the top the last page starts loading. It lands once the reader has moved past the
        // rows it adds, so their first measurement can't move the view and only the row's space counts.
        scroller.scrollTop = 500
        await wait(200)
        scroller.scrollTop = 800
      }
      await wait(200)
      await nextFrame()
      await nextFrame()
      const top = scroller.getBoundingClientRect().top
      const target = [...frame.querySelectorAll<HTMLElement>('[data-native-chat-message-id]')].find(
        (element) => element.getBoundingClientRect().top >= top + 60
      )!
      const before = target.getBoundingClientRect().top
      lastPageGate.resolve()
      await wait(1200)
      const after = target.isConnected ? target.getBoundingClientRect().top : Number.NaN
      frame.querySelector<HTMLElement>('[data-last-page-measurement]')!.textContent =
        `history row shown: ${frame.querySelector('[data-native-chat-older-history]') !== null} · ` +
        `visible rows moved ${Math.round(after - before)}px`
    }
  })
}

export const olderHistoryLastPage = lastPageScene(720)
export const olderHistoryLastPageNarrow = lastPageScene(300)
export const sideOlderHistoryLastPage = lastPageScene(720, true)
export const sideOlderHistoryLastPageNarrow = lastPageScene(300, true)
export const olderHistoryLastPageNearEnd = lastPageScene(720, false, true)

/** At 260px the pane hides the pill, so the row keeps its old place and the transcript its 40px. */
export const olderHistoryLoadingPillHidden = olderHistoryScene(260, 'loading')
