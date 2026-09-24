import { forwardRef, useImperativeHandle, useRef } from 'react'
import { vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionBackgroundTask } from '../../../../shared/agent-session-wire'
import type { NativeChatApprovalCardProps } from './NativeChatApprovalCard'
import type { NativeChatQuestionCardProps } from './NativeChatQuestionCard'
import type { NativeChatLaunchSeed } from './native-chat-composer-types'
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

type StructuredSessionMessageListProps = {
  allowFileUriLinks?: boolean
  isVisible?: boolean
  onLinkClick?: (...args: unknown[]) => void
  showTurnStatus?: boolean
  showLiveTurnActivity?: boolean
  isWorking?: boolean
  runtimeContext?: unknown
}

const initialMessageListProps: StructuredSessionMessageListProps | null = null
const initialApprovalCardProps: NativeChatApprovalCardProps | null = null

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
    retryLaunch: vi.fn<(...args: never[]) => unknown>(),
    controllerProps: nullable<{ transportEnabled?: boolean }>(),
    mode: 'static' as 'static' | 'outbox',
    status: 'ready' as 'idle' | 'loading' | 'ready' | 'error',
    messages: null as null | unknown[],
    messageListProps: initialMessageListProps,
    composerProps: null as null | {
      launchSeed?: NativeChatLaunchSeed
      structuredTransport?: Record<string, unknown>
      isWorking?: boolean
    },
    approvalCardProps: initialApprovalCardProps,
    questionCardProps: null as NativeChatQuestionCardProps | null,
    promptItems: [] as AgentJournalRenderItem[],
    respond: vi.fn<(...args: never[]) => unknown>(),
    cancel: vi.fn<(...args: never[]) => unknown>(),
    handlePasteEvent: vi.fn<(...args: never[]) => unknown>(),
    pasteFromClipboard: vi.fn<(...args: never[]) => unknown>(),
    submissions: [] as unknown[],
    monitoringBackgroundTasks: false,
    showBackgroundTasks: false,
    isWorking: false,
    turnId: null as string | null,
    supportsBackgroundTaskStop: false,
    supportsBackgroundTaskStopAll: true,
    backgroundTasks: [] as AgentSessionBackgroundTask[],
    settledBackgroundTasks: [] as AgentSessionBackgroundTask[],
    threadGoal: nullable<StructuredAgentSessionThreadGoal>(),
    stopBackgroundTask: vi.fn<StopBackgroundTaskSpy>()
  }

  const moduleFactories = {
    structuredAgentSessionClient: () => ({
      callStructuredAgentSession: mocks.call
    }),
    useStructuredAgentSession: async () => {
      const { useStructuredAgentSessionOutbox } =
        await import('./use-structured-agent-session-outbox')
      return {
        useStructuredAgentSession: (props: {
          sessionId: string
          target: { kind: 'local' } | { kind: 'environment'; environmentId: string }
          transportEnabled?: boolean
        }) => {
          mocks.controllerProps = props
          const outbox = useStructuredAgentSessionOutbox({
            sessionId: props.sessionId,
            target: props.target,
            fence: props.transportEnabled === false ? null : 1,
            submissions: mocks.submissions as never
          })
          return {
            messages:
              mocks.messages ??
              (mocks.mode === 'outbox'
                ? []
                : [
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
                  ]),
            status: mocks.status,
            error: outbox.error,
            hasOlder: false,
            loadingOlder: false,
            loadOlder: vi.fn<() => Promise<void>>(),
            prompts: mocks.promptItems,
            outbox: outbox.outbox,
            blockedClientMessageId: outbox.blockedClientMessageId,
            send: outbox.send,
            retry: outbox.retry,
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
      useStructuredAgentSessionLaunchLifecycle: () => mocks.launchLifecycle
    }),
    useNativeChatFontScale: () => ({
      useNativeChatFontScale: () => ({ scale: 1 })
    }),
    useNativeChatFileLinkContext: () => ({
      useNativeChatFileLinkContext: () => ({
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        runtimeEnvironmentId: null
      })
    }),
    useNativeChatFileLinkClick: () => ({
      useNativeChatFileLinkClick: (context: unknown) => (context ? mocks.fileLinkClick : undefined)
    }),
    nativeChatMessageList: () => ({
      NativeChatMessageList: (props: typeof mocks.messageListProps) => {
        mocks.messageListProps = props
        return <div data-testid="message-list" />
      }
    }),
    nativeChatComposer: () => ({
      NativeChatComposer: forwardRef((props: typeof mocks.composerProps, ref) => {
        mocks.composerProps = props
        const fieldRef = useRef<HTMLTextAreaElement>(null)
        useImperativeHandle(ref, () => ({
          // Real DOM focus: the reveal-focus loop retries until focus lands in the pane.
          focus: () => {
            fieldRef.current?.focus()
            return true
          },
          insertTypedText: () => true,
          handlePasteEvent: mocks.handlePasteEvent,
          pasteFromClipboard: mocks.pasteFromClipboard
        }))
        return <textarea ref={fieldRef} data-testid="structured-composer" />
      })
    }),
    nativeChatEmptyState: () => ({ NativeChatEmptyState: () => null }),
    nativeChatApprovalCard: () => ({
      NativeChatApprovalCard: (props: NativeChatApprovalCardProps) => {
        mocks.approvalCardProps = props
        return null
      }
    }),
    nativeChatQuestionCard: () => ({
      NativeChatQuestionCard: (props: NativeChatQuestionCardProps) => {
        mocks.questionCardProps = props
        return null
      }
    })
  }

  const resetStructuredSessionMocks = (): void => {
    mocks.call.mockReset()
    mocks.launchLifecycle = null
    mocks.retryLaunch.mockReset()
    mocks.controllerProps = null
    mocks.mode = 'static'
    mocks.status = 'ready'
    mocks.messages = null
    mocks.messageListProps = null
    mocks.composerProps = null
    mocks.approvalCardProps = null
    mocks.questionCardProps = null
    mocks.promptItems = []
    mocks.respond.mockReset()
    mocks.cancel.mockReset()
    mocks.handlePasteEvent.mockReset()
    mocks.pasteFromClipboard.mockReset()
    mocks.submissions = []
    mocks.monitoringBackgroundTasks = false
    mocks.showBackgroundTasks = false
    mocks.isWorking = false
    mocks.turnId = null
    mocks.supportsBackgroundTaskStop = false
    mocks.supportsBackgroundTaskStopAll = true
    mocks.stopBackgroundTask.mockReset()
    mocks.backgroundTasks = []
    mocks.settledBackgroundTasks = []
    mocks.threadGoal = null
  }

  return { mocks, moduleFactories, resetStructuredSessionMocks }
}
