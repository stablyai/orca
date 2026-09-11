import { forwardRef, useImperativeHandle, useRef } from 'react'
import { vi, type Mock } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionBackgroundTask } from '../../../../shared/agent-session-wire'
import type { NativeChatQuestionCardProps } from './NativeChatQuestionCard'
import type { NativeChatLaunchSeed } from './native-chat-composer-types'
import type { StructuredAgentSessionHoldState } from './structured-agent-session-hold-outcome'

// Why: a named spy type keeps the harness's inferred return type portable across the test files.
type StructuredSessionSpy = Mock

/**
 * Shared mock state and `vi.mock` factories for the NativeChatStructuredSession test files.
 * Load it through `await vi.hoisted(async () => (await import(...)).createStructuredSessionMocks())`
 * so the factories can close over `mocks` before the mocked modules resolve.
 */
export function createStructuredSessionMocks() {
  const mocks = {
    call: vi.fn() as StructuredSessionSpy,
    fileLinkClick: vi.fn() as StructuredSessionSpy,
    mode: 'static' as 'static' | 'outbox',
    status: 'ready' as 'idle' | 'loading' | 'ready' | 'error',
    messages: null as null | unknown[],
    messageListProps: null as null | {
      allowFileUriLinks?: boolean
      onLinkClick?: (...args: unknown[]) => void
      showTurnStatus?: boolean
      runtimeContext?: unknown
    },
    composerProps: null as null | {
      launchSeed?: NativeChatLaunchSeed
      structuredTransport?: Record<string, unknown>
      isWorking?: boolean
      canSend?: boolean
    },
    questionCardProps: null as NativeChatQuestionCardProps | null,
    promptItems: [] as AgentJournalRenderItem[],
    respond: vi.fn() as StructuredSessionSpy,
    handlePasteEvent: vi.fn() as StructuredSessionSpy,
    pasteFromClipboard: vi.fn() as StructuredSessionSpy,
    submissions: [] as unknown[],
    monitoringBackgroundTasks: false,
    showBackgroundTasks: false,
    isWorking: false,
    turnId: null as string | null,
    supportsBackgroundTaskStop: false,
    supportsBackgroundTaskStopAll: true,
    backgroundTasks: [] as AgentSessionBackgroundTask[],
    settledBackgroundTasks: [] as AgentSessionBackgroundTask[],
    stopBackgroundTask: vi.fn() as StructuredSessionSpy,
    hold: { kind: 'held' } as StructuredAgentSessionHoldState,
    retryHold: vi.fn() as StructuredSessionSpy
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
        }) => {
          const outbox = useStructuredAgentSessionOutbox({
            sessionId: props.sessionId,
            target: props.target,
            fence: 1,
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
            cached: false,
            readOnly: false,
            hold: mocks.hold,
            retryHold: mocks.retryHold,
            hasOlder: false,
            loadingOlder: false,
            loadOlder: vi.fn() as StructuredSessionSpy,
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
            cancel: vi.fn() as StructuredSessionSpy,
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
              setOption: vi.fn() as StructuredSessionSpy,
              invokeAction: vi.fn() as StructuredSessionSpy,
              subscribe: () => () => {}
            },
            setStructuredOption: vi.fn() as StructuredSessionSpy
          }
        }
      }
    },
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
    nativeChatApprovalCard: () => ({ NativeChatApprovalCard: () => null }),
    nativeChatQuestionCard: () => ({
      NativeChatQuestionCard: (props: NativeChatQuestionCardProps) => {
        mocks.questionCardProps = props
        return null
      }
    })
  }

  const resetStructuredSessionMocks = (): void => {
    mocks.call.mockReset()
    mocks.mode = 'static'
    mocks.status = 'ready'
    mocks.messages = null
    mocks.messageListProps = null
    mocks.composerProps = null
    mocks.questionCardProps = null
    mocks.promptItems = []
    mocks.respond.mockReset()
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
    mocks.hold = { kind: 'held' }
    mocks.retryHold.mockReset()
  }

  return { mocks, moduleFactories, resetStructuredSessionMocks }
}
