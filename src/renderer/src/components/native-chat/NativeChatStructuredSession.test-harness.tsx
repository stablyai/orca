import { act } from '@testing-library/react'
import { useImperativeHandle } from 'react'
import { vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { QueuedMessageCard } from './structured-agent-session-queued-cards'
import type { AgentSessionBackgroundTask } from '../../../../shared/agent-session-wire'
import type { AgentSessionWriteRefusal } from '../../../../shared/agent-session-write-failure'
import type { AgentSessionUnavailable } from '../../../../shared/agent-session-availability'
import type { AgentSessionRefusalReference } from '../../../../shared/agent-session-wire-refusals'
import type { NativeChatApprovalCardProps } from './NativeChatApprovalCard'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'
import type { NativeChatQuestionCardProps } from './NativeChatQuestionCard'
import type { NativeChatLaunchSeed } from './native-chat-composer-types'
import type { NativeChatMessageListHandle } from './use-native-chat-reveal-latest'
import type { NativeChatFileLinkContext } from './native-chat-file-link'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'
import { createStructuredSessionComposerMock } from './NativeChatStructuredSession.test-composer'
import type { NativeChatOlderPageResult } from './native-chat-pagination'
import type { StructuredAgentSessionThreadGoal } from './use-structured-agent-session-thread-goal'
import type { StructuredAgentSessionLaunchLifecycle } from '@/lib/structured-agent-session-launch'
import type {
  SessionOptionSetResult,
  SessionOptionValue
} from '../../../../shared/native-chat-session-options'

type StopBackgroundTaskSpy = (sessionId: string, taskId?: string) => unknown

function nullable<T>(): T | null {
  return null
}

function widened<T>(value: T): T {
  return value
}

function absent<T>(): T | undefined {
  return undefined
}

/** Stands in for the transcript: renders only each message's delivery notice, or the row's quiet
 *  "Sending…" while nothing has confirmed it. */
export function DeliveryNoticesMock({
  notices
}: {
  notices?: ReadonlyMap<string, NativeChatDeliveryNotice>
}): React.JSX.Element {
  return (
    <div data-testid="message-list">
      {[...(notices ?? [])].map(([id, notice]) => (
        <div key={id} data-message-id={id}>
          <span>{notice.sending ? 'Sending…' : notice.text}</span>
        </div>
      ))}
    </div>
  )
}

export function useProbeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
}

export async function advanceProbeClock(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds)
  })
}

export function seededEntry(
  sessionId: string,
  clientMessageId: string,
  text: string,
  state: 'queued' | 'unconfirmed'
) {
  return {
    clientMessageId,
    sessionId,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
    previewUris: [],
    state,
    queuedAt: clientMessageId === 'op-head' ? 1 : 2,
    lastAttemptAt: null,
    // Already force-retried once, so the automatic probe leaves the head alone
    // and only the user's Retry moves it.
    retryAfterUnknownSubmittedAt: -1
  }
}

export function seedOutbox(sessionId: string, entries: unknown[]): void {
  localStorage.setItem(
    `orca:desktopStructuredAgentSessionOutbox:v1:${encodeURIComponent(sessionId)}`,
    JSON.stringify(entries)
  )
}

type StructuredSessionMessageListProps = {
  ref?: React.Ref<NativeChatMessageListHandle>
  allowFileUriLinks?: boolean
  isVisible?: boolean
  onLinkClick?: (...args: unknown[]) => void
  awaitingInput?: 'shown' | 'unshown' | null
  isWorking?: boolean
  stopping?: boolean
  runtimeContext?: unknown
  session?: { hasMore: boolean; loadingEarlier: boolean; loadEarlier: () => Promise<void> }
  deliveryNotices?: ReadonlyMap<string, NativeChatDeliveryNotice>
}

const DEFAULT_FILE_LINK_CONTEXT: NativeChatFileLinkContext = {
  worktreeId: 'wt-1',
  worktreePath: '/repo',
  runtimeEnvironmentId: null
}

const initialMessageListProps: StructuredSessionMessageListProps | null = null
const initialApprovalCardProps: NativeChatApprovalCardProps | null = null
type QueueResumeMock = { resume: () => void; resuming: boolean }

/**
 * Shared mock state and `vi.mock` factories for the NativeChatStructuredSession test files.
 * Load it through `await vi.hoisted(async () => (await import(...)).createStructuredSessionMocks())`
 * so the factories can close over `mocks` before the mocked modules resolve.
 */
export function createStructuredSessionMocks() {
  const mocks = {
    call: vi.fn<(...args: never[]) => unknown>(),
    fileLinkClick: vi.fn<(...args: never[]) => unknown>(),
    launchLifecycle: nullable<StructuredAgentSessionLaunchLifecycle>(),
    ownerWorktreeId: widened<string | null>('wt-1'),
    fileLinkContext: widened<NativeChatFileLinkContext | null>(DEFAULT_FILE_LINK_CONTEXT),
    lifecycleLookup: vi.fn<(worktreeId: string, sessionId: string) => void>(),
    launchFailure: nullable<AgentSessionWriteRefusal>(),
    launchResumes: false,
    retryLaunch: vi.fn<(worktreeId: string, sessionId: string) => unknown>(),
    relaunchWithMessage: vi.fn<(worktreeId: string, sessionId: string, text: string) => void>(),
    controllerProps: nullable<{ transportEnabled?: boolean }>(),
    send: vi.fn<(text: string, attachments?: unknown[]) => boolean>(() => true),
    status: 'ready' as 'idle' | 'loading' | 'ready' | 'error',
    readRefusal: absent<AgentSessionRefusalReference>(),
    messages: null as null | unknown[],
    messageListProps: initialMessageListProps,
    composerProps: nullable<{
      launchSeed?: NativeChatLaunchSeed
      structuredTransport?: Record<string, unknown> & {
        queueResume?: QueueResumeMock
        onError?: (text: string | null, errorText?: string) => void
      }
      isWorking?: boolean
      isStopping?: boolean
      afterStop?: 'queue' | 'send'
      steerQueued?: () => boolean
      onStop?: () => void
      notices?: readonly NativeChatComposerNotice[]
    }>(),
    approvalCardProps: initialApprovalCardProps,
    questionCardProps: null as NativeChatQuestionCardProps | null,
    promptItems: [] as AgentJournalRenderItem[],
    journalItems: new Array<AgentJournalRenderItem>(),
    respond: vi.fn<(...args: never[]) => unknown>(),
    cancel: vi.fn<(...args: never[]) => unknown>(),
    stop: vi.fn<() => unknown>(),
    handlePasteEvent: vi.fn<(...args: never[]) => unknown>(),
    pasteFromClipboard: vi.fn<(...args: never[]) => unknown>(),
    submissions: [] as unknown[],
    monitoringBackgroundTasks: false,
    showBackgroundTasks: false,
    isWorking: false,
    turnId: null as string | null,
    // Unset: Stop follows the turn, as against an older host.
    canStop: nullable<boolean>(),
    stopPressed: false,
    sendsQueue: false,
    supportsBackgroundTaskStop: false,
    supportsBackgroundTaskStopAll: true,
    backgroundTasks: [] as AgentSessionBackgroundTask[],
    settledBackgroundTasks: [] as AgentSessionBackgroundTask[],
    threadGoal: nullable<StructuredAgentSessionThreadGoal>(),
    stopBackgroundTask: vi.fn<StopBackgroundTaskSpy>(),
    hasOlder: false,
    loadingOlder: false,
    olderHistoryGeneration: 0,
    loadOlder: vi.fn<() => Promise<NativeChatOlderPageResult>>(),
    queuedCards: Array.of<QueuedMessageCard>(),
    queuedSteer: vi.fn<(messageId: string) => Promise<void>>(async () => {}),
    queuedRemove: vi.fn<(messageId: string) => Promise<void>>(async () => {}),
    queuedEdit: vi.fn<(messageId: string) => Promise<void>>(async () => {}),
    queuedSteerNewest: vi.fn<() => boolean>(() => false),
    queuedResumable: false,
    queueSendsNext: false,
    unavailable: nullable<AgentSessionUnavailable>(),
    queuedResume: vi.fn<() => Promise<boolean>>(async () => true),
    revealLatest: vi.fn<() => void>()
  }

  const moduleFactories = {
    structuredAgentSessionClient: () => ({
      callStructuredAgentSession: mocks.call,
      // The pane activates the host status feed for its startup phase; nothing here drives it.
      subscribeStructuredAgentSessionStatus: async () => ({ unsubscribe: () => {} })
    }),
    useStructuredAgentSession: async () => {
      return {
        useStructuredAgentSession: (props: {
          sessionId: string
          target: { kind: 'local' } | { kind: 'environment'; environmentId: string }
          transportEnabled?: boolean
        }) => {
          mocks.controllerProps = props
          return {
            journalItems: mocks.journalItems,
            messages: mocks.messages ?? [
              {
                id: 'message-1',
                role: 'assistant',
                source: 'transcript',
                timestamp: 1,
                blocks: [
                  {
                    type: 'text',
                    text: '[file](file:///repo/src/main.ts)'
                  }
                ]
              }
            ],
            status: mocks.status,
            error: null,
            readRefusal: mocks.readRefusal,
            hasOlder: mocks.hasOlder,
            loadingOlder: mocks.loadingOlder,
            olderHistoryGeneration: mocks.olderHistoryGeneration,
            loadOlder: mocks.loadOlder,
            prompts: mocks.promptItems,
            pending: [],
            submissions: mocks.submissions,
            send: mocks.send,
            isWorking: mocks.isWorking,
            backgroundTasks: {
              show: mocks.showBackgroundTasks || mocks.monitoringBackgroundTasks,
              isMonitoring: mocks.monitoringBackgroundTasks,
              tasks: mocks.backgroundTasks,
              settledTasks: mocks.settledBackgroundTasks,
              supportsStop: mocks.supportsBackgroundTaskStop,
              supportsStopAll: mocks.supportsBackgroundTaskStopAll
            },
            turnId: mocks.turnId,
            epoch: 'epoch-1',
            rewind: { surface: undefined },
            canStop: mocks.canStop ?? mocks.turnId !== null,
            queueSendsNext: mocks.queueSendsNext,
            unavailable: mocks.unavailable,
            stopPressed: mocks.stopPressed,
            sendsQueue: mocks.sendsQueue,
            stop: mocks.stop,
            queuedMessages: {
              cards: mocks.queuedCards,
              steer: mocks.queuedSteer,
              remove: mocks.queuedRemove,
              edit: mocks.queuedEdit,
              steerNewest: mocks.queuedSteerNewest,
              queueResume: mocks.queuedResumable
                ? { resume: mocks.queuedResume, resuming: false }
                : undefined
            },
            threadGoal: mocks.threadGoal,
            cancel: mocks.cancel,
            stopBackgroundTask: (taskId?: string) =>
              mocks.stopBackgroundTask(props.sessionId, taskId),
            respond: mocks.respond,
            optionSnapshot: [
              {
                id: 'model',
                label: 'Model',
                category: 'model',
                kind: {
                  type: 'select',
                  currentValue: 'gpt-live',
                  choices: [{ value: 'gpt-live', label: 'GPT Live' }]
                },
                valueSource: 'reported',
                settable: true
              }
            ],
            optionSurface: {
              getSnapshot: () => [],
              setOption:
                vi.fn<(id: string, value: SessionOptionValue) => Promise<SessionOptionSetResult>>(),
              invokeAction: vi.fn<(id: string) => Promise<SessionOptionSetResult>>(),
              subscribe: () => () => {}
            },
            setStructuredOption:
              vi.fn<(id: string, value: SessionOptionValue) => Promise<boolean>>()
          }
        }
      }
    },
    structuredAgentSessionLaunch: () => ({
      retryStructuredAgentSessionLaunch: mocks.retryLaunch,
      relaunchFailedStructuredAgentSessionForMessage: (worktreeId: string, sessionId: string) => {
        if (mocks.launchLifecycle === 'failed') {
          mocks.retryLaunch(worktreeId, sessionId)
        }
      },
      getStructuredAgentSessionLaunchLifecycle: () => mocks.launchLifecycle,
      getStructuredAgentSessionLaunchResumes: () => mocks.launchResumes,
      useStructuredAgentSessionLaunchSelection: () => null,
      useStructuredAgentSessionLaunchLifecycle: (worktreeId: string, sessionId: string) => {
        mocks.lifecycleLookup(worktreeId, sessionId)
        return mocks.launchLifecycle
      },
      useStructuredAgentSessionLaunchFailure: () => mocks.launchFailure
    }),
    structuredAgentSessionLaunchMessage: () => ({
      relaunchFailedStructuredAgentSessionWithMessage: (
        worktreeId: string,
        sessionId: string,
        text: string
      ) => {
        if (mocks.launchLifecycle !== 'failed') {
          return null
        }
        mocks.retryLaunch(worktreeId, sessionId)
        mocks.relaunchWithMessage(worktreeId, sessionId, text)
        return new Promise(() => {})
      }
    }),
    useNativeChatFontSize: () => ({
      useNativeChatFontSize: () => undefined
    }),
    useNativeChatFileLinkContext: () => ({
      useNativeChatFileLinkContext: () => mocks.fileLinkContext
    }),
    useNativeChatTabOwner: () => ({
      useNativeChatTabOwnerWorktreeId: () => mocks.ownerWorktreeId
    }),
    useNativeChatFileLinkClick: () => ({
      useNativeChatFileLinkClick: (context: unknown) => (context ? mocks.fileLinkClick : undefined)
    }),
    nativeChatMessageList: () => ({
      NativeChatMessageList: (props: typeof mocks.messageListProps) => {
        mocks.messageListProps = props
        useImperativeHandle(props?.ref, () => ({ revealLatest: mocks.revealLatest }))
        return <DeliveryNoticesMock notices={props?.deliveryNotices} />
      }
    }),
    nativeChatComposer: () => createStructuredSessionComposerMock(mocks),
    nativeChatEmptyState: () => ({ NativeChatEmptyState: () => null }),
    nativeChatApprovalCard: () => ({
      NativeChatApprovalCard: (props: NativeChatApprovalCardProps) => {
        mocks.approvalCardProps = props
        return <div data-native-chat-approval-card-mock />
      }
    }),
    nativeChatQuestionCard: () => ({
      NativeChatQuestionCard: (props: NativeChatQuestionCardProps) => {
        mocks.questionCardProps = props
        return <div data-native-chat-question-card-mock />
      }
    })
  }

  const resetStructuredSessionMocks = (): void => {
    mocks.call.mockReset()
    mocks.launchLifecycle = null
    mocks.ownerWorktreeId = 'wt-1'
    mocks.fileLinkContext = DEFAULT_FILE_LINK_CONTEXT
    mocks.launchFailure = null
    mocks.launchResumes = false
    mocks.retryLaunch.mockReset()
    mocks.relaunchWithMessage.mockReset()
    mocks.lifecycleLookup.mockReset()
    mocks.controllerProps = null
    mocks.send.mockClear()
    mocks.status = 'ready'
    mocks.readRefusal = undefined
    mocks.messages = null
    mocks.messageListProps = null
    mocks.composerProps = null
    mocks.approvalCardProps = null
    mocks.questionCardProps = null
    mocks.promptItems = []
    mocks.journalItems = []
    mocks.respond.mockReset()
    mocks.cancel.mockReset()
    mocks.stop.mockReset()
    mocks.handlePasteEvent.mockReset()
    mocks.pasteFromClipboard.mockReset()
    mocks.submissions = []
    mocks.monitoringBackgroundTasks = false
    mocks.showBackgroundTasks = false
    mocks.isWorking = false
    mocks.turnId = null
    mocks.canStop = null
    mocks.stopPressed = false
    mocks.sendsQueue = false
    mocks.supportsBackgroundTaskStop = false
    mocks.supportsBackgroundTaskStopAll = true
    mocks.stopBackgroundTask.mockReset()
    mocks.backgroundTasks = []
    mocks.settledBackgroundTasks = []
    mocks.threadGoal = null
    mocks.hasOlder = false
    mocks.loadingOlder = false
    mocks.olderHistoryGeneration = 0
    mocks.loadOlder.mockReset()
    Object.assign(mocks, { queuedResumable: false, queueSendsNext: false, unavailable: null })
    mocks.queuedResume.mockReset()
    mocks.revealLatest.mockReset()
    mocks.queuedSteerNewest.mockReset()
    mocks.queuedSteerNewest.mockReturnValue(false)
  }

  return { mocks, moduleFactories, resetStructuredSessionMocks }
}
