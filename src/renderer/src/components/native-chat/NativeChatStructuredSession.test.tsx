// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionBackgroundTask } from '../../../../shared/agent-session-wire'
import { decodeAgentSessionQuestionAnswers } from '../../../../shared/agent-session-question-answer'
import type { NativeChatQuestionCardProps } from './NativeChatQuestionCard'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  fileLinkClick: vi.fn(),
  mode: 'static' as 'static' | 'outbox',
  messageListProps: null as null | {
    allowFileUriLinks?: boolean
    onLinkClick?: (...args: unknown[]) => void
    showTurnStatus?: boolean
    runtimeContext?: unknown
  },
  composerProps: null as null | {
    structuredTransport?: Record<string, unknown>
    isWorking?: boolean
  },
  questionCardProps: null as NativeChatQuestionCardProps | null,
  promptItems: [] as AgentJournalRenderItem[],
  respond: vi.fn(),
  handlePasteEvent: vi.fn(),
  pasteFromClipboard: vi.fn(),
  submissions: [] as unknown[],
  monitoringBackgroundTasks: false,
  supportsBackgroundTaskStop: false,
  supportsBackgroundTaskStopAll: true,
  backgroundTasks: [] as AgentSessionBackgroundTask[],
  stopBackgroundTask: vi.fn()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('./use-structured-agent-session', async () => {
  const { useStructuredAgentSessionOutbox } = await import('./use-structured-agent-session-outbox')
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
          mocks.mode === 'outbox'
            ? []
            : [
                {
                  id: 'message-1',
                  role: 'assistant',
                  source: 'transcript',
                  timestamp: 1,
                  blocks: [{ type: 'text', text: '[file](file:///repo/src/main.ts)' }]
                }
              ],
        status: 'ready' as const,
        error: outbox.error,
        hasOlder: false,
        loadingOlder: false,
        loadOlder: vi.fn(),
        prompts: mocks.promptItems,
        outbox: outbox.outbox,
        blockedClientMessageId: outbox.blockedClientMessageId,
        send: outbox.send,
        retry: outbox.retry,
        isWorking: false,
        isMonitoringBackgroundTasks: mocks.monitoringBackgroundTasks,
        supportsBackgroundTaskStop: mocks.supportsBackgroundTaskStop,
        supportsBackgroundTaskStopAll: mocks.supportsBackgroundTaskStopAll,
        backgroundTasks: mocks.backgroundTasks,
        turnId: null,
        cancel: vi.fn(),
        stopBackgroundTask: (taskId?: string) => mocks.stopBackgroundTask(props.sessionId, taskId),
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
          setOption: vi.fn(),
          invokeAction: vi.fn(),
          subscribe: () => () => {}
        },
        setStructuredOption: vi.fn()
      }
    }
  }
})

vi.mock('./use-native-chat-font-scale', () => ({
  useNativeChatFontScale: () => ({ scale: 1 })
}))

vi.mock('./use-native-chat-file-link-context', () => ({
  useNativeChatFileLinkContext: () => ({
    worktreeId: 'wt-1',
    worktreePath: '/repo',
    runtimeEnvironmentId: null
  })
}))

vi.mock('./use-native-chat-file-link-click', () => ({
  useNativeChatFileLinkClick: (context: unknown) => (context ? mocks.fileLinkClick : undefined)
}))

vi.mock('./NativeChatMessageList', () => ({
  NativeChatMessageList: (props: typeof mocks.messageListProps) => {
    mocks.messageListProps = props
    return <div data-testid="message-list" />
  }
}))

vi.mock('./NativeChatComposer', () => ({
  NativeChatComposer: forwardRef((props: typeof mocks.composerProps, ref) => {
    mocks.composerProps = props
    useImperativeHandle(ref, () => ({
      focus: () => true,
      insertTypedText: () => true,
      handlePasteEvent: mocks.handlePasteEvent,
      pasteFromClipboard: mocks.pasteFromClipboard
    }))
    return <textarea data-testid="structured-composer" />
  })
}))
vi.mock('./NativeChatEmptyState', () => ({ NativeChatEmptyState: () => null }))
vi.mock('./NativeChatApprovalCard', () => ({ NativeChatApprovalCard: () => null }))
vi.mock('./NativeChatQuestionCard', () => ({
  NativeChatQuestionCard: (props: NativeChatQuestionCardProps) => {
    mocks.questionCardProps = props
    return null
  }
}))

import { NativeChatStructuredSession } from './NativeChatStructuredSession'

describe('NativeChatStructuredSession', () => {
  afterEach(() => {
    cleanup()
    mocks.call.mockReset()
    mocks.mode = 'static'
    mocks.messageListProps = null
    mocks.composerProps = null
    mocks.questionCardProps = null
    mocks.promptItems = []
    mocks.respond.mockReset()
    mocks.handlePasteEvent.mockReset()
    mocks.pasteFromClipboard.mockReset()
    mocks.submissions = []
    mocks.monitoringBackgroundTasks = false
    mocks.supportsBackgroundTaskStop = false
    mocks.supportsBackgroundTaskStopAll = true
    mocks.stopBackgroundTask.mockReset()
    mocks.backgroundTasks = []
  })

  it('routes app-menu paste into the structured composer', () => {
    render(
      <NativeChatStructuredSession
        isVisible
        tabId="structured-tab-paste"
        sessionId="session-paste"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    const composer = screen.getByTestId('structured-composer')
    composer.focus()
    window.dispatchEvent(new Event('orca-app-menu-paste', { cancelable: true }))

    expect(mocks.pasteFromClipboard).toHaveBeenCalledOnce()
  })

  it('wires remote structured file links through the host-aware native chat opener', () => {
    render(
      <NativeChatStructuredSession
        isVisible
        tabId="structured-tab-1"
        sessionId="session-1"
        target={{ kind: 'environment', environmentId: 'env-1' }}
        agent="codex"
      />
    )

    expect(mocks.messageListProps?.allowFileUriLinks).toBe(true)
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() }
    mocks.messageListProps?.onLinkClick?.(event, 'file:///repo/src/a.ts')
    expect(mocks.fileLinkClick).toHaveBeenCalledWith(event, 'file:///repo/src/a.ts')
  })

  // Turn status and transcript image previews shipped Codex-first. Every
  // structured session renders through the same list, so neither is agent-gated.
  it.each(['codex', 'claude'] as const)(
    'renders the same structured transcript chrome for %s',
    (agent) => {
      render(
        <NativeChatStructuredSession
          isVisible
          tabId="structured-tab-parity"
          sessionId="session-parity"
          target={{ kind: 'local' }}
          agent={agent}
        />
      )

      expect(mocks.messageListProps?.showTurnStatus).toBe(true)
      expect(mocks.messageListProps?.runtimeContext).not.toBeUndefined()
    }
  )

  it('places background monitoring above the usable composer and stops without an active turn', async () => {
    mocks.monitoringBackgroundTasks = true
    mocks.supportsBackgroundTaskStop = true
    mocks.backgroundTasks = [
      { id: 'task-command', kind: 'command', description: 'sleep 180' },
      { id: 'task-agent', kind: 'agent' }
    ]
    mocks.stopBackgroundTask.mockResolvedValue({ cancelled: true })

    render(
      <NativeChatStructuredSession
        isVisible
        tabId="structured-tab-background"
        sessionId="session-background"
        target={{ kind: 'local' }}
        agent="claude"
      />
    )

    const status = screen
      .getByText('Monitoring background tasks')
      .closest('[data-native-chat-background-tasks="true"]')
    const composer = screen.getByTestId('structured-composer')
    if (!status) {
      throw new Error('background task status was not rendered')
    }
    expect(status.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(mocks.composerProps?.isWorking).toBe(false)
    expect(screen.queryByRole('list', { name: 'Running background tasks' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Stop / })).toBeNull()

    const disclosure = screen.getByRole('button', { name: 'Monitoring background tasks' })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(disclosure)
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('list', { name: 'Running background tasks' })).toBeTruthy()
    expect(screen.getByText('sleep 180')).toBeTruthy()
    expect(screen.getByText('Background agent')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Stop sleep 180' }))
    await waitFor(() =>
      expect(mocks.stopBackgroundTask).toHaveBeenCalledWith('session-background', 'task-command')
    )
  })

  it('tracks concurrent task stops independently and clears each pending result', async () => {
    mocks.monitoringBackgroundTasks = true
    mocks.supportsBackgroundTaskStop = true
    mocks.backgroundTasks = [
      { id: 'task-one', kind: 'command', description: 'First task' },
      { id: 'task-two', kind: 'command', description: 'Second task' }
    ]
    let finishFirst!: (value: unknown) => void
    let finishSecond!: (value: unknown) => void
    mocks.stopBackgroundTask.mockImplementation(
      (_sessionId: string, taskId: string) =>
        new Promise((resolve) => {
          if (taskId === 'task-one') {
            finishFirst = resolve
          } else {
            finishSecond = resolve
          }
        })
    )

    render(
      <NativeChatStructuredSession
        isVisible
        tabId="structured-tab-concurrent-background"
        sessionId="session-concurrent-background"
        target={{ kind: 'local' }}
        agent="claude"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Monitoring background tasks' }))
    const firstStop = screen.getByRole('button', { name: 'Stop First task' })
    const secondStop = screen.getByRole('button', { name: 'Stop Second task' })

    fireEvent.click(firstStop)
    fireEvent.click(secondStop)
    expect((firstStop as HTMLButtonElement).disabled).toBe(true)
    expect((secondStop as HTMLButtonElement).disabled).toBe(true)

    await act(async () => finishFirst({ cancelled: true }))
    await waitFor(() => expect((firstStop as HTMLButtonElement).disabled).toBe(false))
    expect((secondStop as HTMLButtonElement).disabled).toBe(true)

    await act(async () => finishSecond(null))
    await waitFor(() => expect((secondStop as HTMLButtonElement).disabled).toBe(false))
  })

  it('keeps a stale session stop result from clearing the current session pending state', async () => {
    mocks.monitoringBackgroundTasks = true
    mocks.supportsBackgroundTaskStop = true
    mocks.backgroundTasks = [{ id: 'task-one', kind: 'command', description: 'Shared task' }]
    let finishOld!: (value: unknown) => void
    let finishCurrent!: (value: unknown) => void
    mocks.stopBackgroundTask.mockImplementation(
      (sessionId: string) =>
        new Promise((resolve) => {
          if (sessionId === 'session-old') {
            finishOld = resolve
          } else {
            finishCurrent = resolve
          }
        })
    )
    const { rerender } = render(
      <NativeChatStructuredSession
        isVisible
        tabId="structured-tab-stale-background"
        sessionId="session-old"
        target={{ kind: 'local' }}
        agent="claude"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Monitoring background tasks' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop Shared task' }))

    rerender(
      <NativeChatStructuredSession
        isVisible
        tabId="structured-tab-stale-background"
        sessionId="session-current"
        target={{ kind: 'local' }}
        agent="claude"
      />
    )
    const currentStop = screen.getByRole('button', { name: 'Stop Shared task' })
    expect((currentStop as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(currentStop)
    expect((currentStop as HTMLButtonElement).disabled).toBe(true)

    await act(async () => finishOld({ cancelled: true }))
    expect((currentStop as HTMLButtonElement).disabled).toBe(true)
    await act(async () => finishCurrent({ cancelled: true }))
    await waitFor(() => expect((currentStop as HTMLButtonElement).disabled).toBe(false))
  })

  it('keeps the expanded all-task stop fallback for a taskless older host', async () => {
    mocks.monitoringBackgroundTasks = true
    mocks.stopBackgroundTask.mockResolvedValue({ cancelled: true })

    render(
      <NativeChatStructuredSession
        isVisible
        tabId="structured-tab-taskless-background"
        sessionId="session-taskless-background"
        target={{ kind: 'local' }}
        agent="claude"
      />
    )
    expect(screen.queryByRole('button', { name: 'Stop background tasks' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Monitoring background tasks' }))
    expect(screen.getByText('Task details are unavailable for this session.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop background tasks' }))

    await waitFor(() =>
      expect(mocks.stopBackgroundTask).toHaveBeenCalledWith(
        'session-taskless-background',
        undefined
      )
    )
  })

  it('routes a bare model command to the native option picker', async () => {
    render(
      <NativeChatStructuredSession
        isVisible
        tabId="structured-tab-1"
        sessionId="session-1"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )
    const dispatchCommand = mocks.composerProps?.structuredTransport?.dispatchCommand as
      | ((text: string) => Promise<{ accepted: boolean }>)
      | undefined

    await act(async () => {
      await expect(dispatchCommand?.('/model')).resolves.toMatchObject({ accepted: true })
    })

    expect(mocks.composerProps?.structuredTransport?.optionPickerRequest).toEqual({
      id: 'model',
      sequence: 1
    })
  })

  it('passes Claude grouped questions and one shared answer through the card', () => {
    mocks.promptItems = [
      {
        itemId: 'question-item',
        revision: 1,
        sequence: 1,
        observedAt: 1,
        body: {
          kind: 'question',
          question: '2 grouped questions from Claude',
          options: [],
          questions: [
            {
              id: 'q1',
              header: 'Targets',
              question: 'Which targets?',
              multiSelect: true,
              options: [
                { id: 'target-web', label: 'Web' },
                { id: 'target-mobile', label: 'Mobile' }
              ],
              freeTextQuestionId: 'q1'
            },
            {
              id: 'q2',
              header: 'Host',
              question: 'Where should it run?',
              multiSelect: false,
              options: [],
              freeTextQuestionId: 'q2'
            }
          ],
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        }
      }
    ]

    render(
      <NativeChatStructuredSession
        isVisible
        tabId="structured-tab-questions"
        sessionId="session-questions"
        target={{ kind: 'local' }}
        agent="claude"
      />
    )

    const card = mocks.questionCardProps
    if (!card) {
      throw new Error('question card was not rendered')
    }
    expect(card.prompt.questions).toHaveLength(2)
    expect(card.prompt.questions[0]).toMatchObject({
      question: 'Which targets?',
      multiSelect: true,
      options: [{ label: 'Web' }, { label: 'Mobile' }]
    })
    expect(card.allowOther).toEqual([true, true])

    card.onAnswer([
      { indices: [0, 1], other: '' },
      { indices: [], other: 'SSH host' }
    ])
    const encoded = mocks.respond.mock.calls[0]?.[1]
    expect(decodeAgentSessionQuestionAnswers(encoded)).toEqual([
      { questionId: 'q1', optionIds: ['target-web', 'target-mobile'] },
      { questionId: 'q2', optionIds: [], other: 'SSH host' }
    ])
  })

  it('keeps legacy single-question option ids and free text behavior', () => {
    mocks.promptItems = [
      {
        itemId: 'legacy-question-item',
        revision: 1,
        sequence: 1,
        observedAt: 1,
        body: {
          kind: 'question',
          question: 'Pick a library',
          options: [
            { id: 'q1:choice-1', label: 'React' },
            { id: 'q1:choice-2', label: 'Vue' }
          ],
          freeTextQuestionId: 'q1',
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        }
      }
    ]

    render(
      <NativeChatStructuredSession
        isVisible
        tabId="structured-tab-legacy-question"
        sessionId="session-legacy-question"
        target={{ kind: 'local' }}
        agent="claude"
      />
    )

    const card = mocks.questionCardProps
    if (!card) {
      throw new Error('question card was not rendered')
    }
    expect(card.prompt.questions).toEqual([
      {
        question: 'Pick a library',
        multiSelect: false,
        options: [{ label: 'React' }, { label: 'Vue' }]
      }
    ])
    card.onAnswer([{ indices: [1], other: '' }])
    expect(mocks.respond).toHaveBeenCalledWith(mocks.promptItems[0], 'q1:choice-2')
  })
})
