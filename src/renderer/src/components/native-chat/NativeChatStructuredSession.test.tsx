// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeAgentSessionQuestionAnswers } from '../../../../shared/agent-session-question-answer'
import { useAppStore } from '@/store'
import {
  claudeGroupedQuestionPromptItems,
  legacySingleQuestionPromptItems
} from './native-chat-structured-question-test-fixtures'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)

vi.mock('@/runtime/structured-agent-session-client', () =>
  moduleFactories.structuredAgentSessionClient()
)
vi.mock('./use-structured-agent-session', () => moduleFactories.useStructuredAgentSession())
vi.mock('./use-native-chat-font-scale', () => moduleFactories.useNativeChatFontScale())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatEmptyState', () => moduleFactories.nativeChatEmptyState())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())

import { NativeChatStructuredSession } from './NativeChatStructuredSession'

describe('NativeChatStructuredSession', () => {
  afterEach(() => {
    cleanup()
    resetStructuredSessionMocks()
  })

  it('routes the launch draft and app-menu paste to the structured composer', () => {
    const draft = {
      tabId: 'structured-draft-tab',
      agent: 'codex' as const,
      text: 'PR #19423 — review this change',
      createdAt: Date.now()
    }
    useAppStore.getState().seedNativeChatLaunchDraft(draft)
    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId={draft.tabId}
        sessionId="draft-session"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )
    expect(mocks.composerProps?.launchSeed).toEqual({
      launchDraft: draft,
      launchDraftResolved: false,
      ownsTabWideLaunchDraft: true
    })
    act(() => useAppStore.getState().clearNativeChatLaunchDraft(draft.tabId))
    const composer = screen.getByTestId('structured-composer')
    composer.focus()
    window.dispatchEvent(new Event('orca-app-menu-paste', { cancelable: true }))

    expect(mocks.pasteFromClipboard).toHaveBeenCalledOnce()
  })

  // Why: the controller starts at `idle`, before any read; a baseline taken from that empty
  // render would be exceeded by the backfill itself and resolve a draft the user never saw.
  it('holds the launch draft unresolved until the first journal read settles', () => {
    const draft = {
      tabId: 'structured-idle-tab',
      agent: 'codex' as const,
      text: 'PR #19423 — review this change',
      createdAt: Date.now()
    }
    useAppStore.getState().seedNativeChatLaunchDraft(draft)
    mocks.status = 'idle'
    mocks.messages = [
      {
        id: 'user-1',
        role: 'user',
        source: 'transcript',
        timestamp: draft.createdAt + 1,
        blocks: [{ type: 'text', text: draft.text }]
      }
    ]
    const { rerender } = render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId={draft.tabId}
        sessionId="idle-session"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )
    expect(mocks.composerProps?.launchSeed).toMatchObject({
      launchDraft: draft,
      launchDraftResolved: false
    })

    mocks.status = 'ready'
    rerender(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId={draft.tabId}
        sessionId="idle-session"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )
    expect(mocks.composerProps?.launchSeed?.launchDraftResolved).toBe(true)
    act(() => useAppStore.getState().clearNativeChatLaunchDraft(draft.tabId))
  })

  it('wires remote structured file links through the host-aware native chat opener', () => {
    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
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
          isFocusedGroup
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

  // Every background-task test mounts the same local Claude session; only the ids
  // differ. A fresh element per call also matters for the rerenders below: React
  // bails out of re-rendering an identical one.
  const claudeSessionView = (tabId: string, sessionId: string) => (
    <NativeChatStructuredSession
      isVisible
      isFocusedGroup
      tabId={tabId}
      sessionId={sessionId}
      target={{ kind: 'local' }}
      agent="claude"
    />
  )

  it('places background monitoring above the usable composer, keeps its list open across a gap in live work, and stops without an active turn', async () => {
    mocks.monitoringBackgroundTasks = true
    mocks.supportsBackgroundTaskStop = true
    mocks.backgroundTasks = [
      { id: 'task-command', kind: 'command', description: 'sleep 180' },
      { id: 'task-agent', kind: 'agent' }
    ]
    mocks.stopBackgroundTask.mockResolvedValue({ cancelled: true })

    const { rerender } = render(
      claudeSessionView('structured-tab-background', 'session-background')
    )

    const disclosure = screen.getByRole('button', { name: '1 agent · 1 shell' })
    const status = disclosure.closest('[data-native-chat-background-tasks="true"]')
    const composer = screen.getByTestId('structured-composer')
    if (!status) {
      throw new Error('background task status was not rendered')
    }
    expect(status.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(mocks.composerProps?.isWorking).toBe(false)
    expect(screen.queryByRole('list', { name: 'Agents' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Stop / })).toBeNull()

    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(disclosure)
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('list', { name: 'Agents' })).toBeTruthy()
    expect(screen.getByRole('list', { name: 'Shell' })).toBeTruthy()
    expect(screen.getByText('sleep 180')).toBeTruthy()
    expect(screen.getByText('Background agent')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Stop sleep 180' }))
    await waitFor(() =>
      expect(mocks.stopBackgroundTask).toHaveBeenCalledWith('session-background', 'task-command')
    )

    // The strip is mounted on live work, and settled rows are flushed the instant
    // the last live one ends, so a sequential fan-out unmounts it between one
    // subagent finishing and the next starting. The disclosure is not the
    // strip's to forget in that gap.
    mocks.monitoringBackgroundTasks = false
    rerender(claudeSessionView('structured-tab-background', 'session-background'))
    expect(document.querySelector('[data-native-chat-background-tasks="true"]')).toBeNull()
    mocks.monitoringBackgroundTasks = true
    rerender(claudeSessionView('structured-tab-background', 'session-background'))
    expect(screen.getByRole('list', { name: 'Agents' })).toBeTruthy()
  })

  it('keeps the strip mounted through a running turn, with the turn owning the voice', () => {
    // The strip stands for work that OUTLIVES a turn, so `show` is true while
    // `isMonitoring` is false: mounted, but not speaking as the live indicator.
    mocks.showBackgroundTasks = true
    mocks.monitoringBackgroundTasks = false
    mocks.isWorking = true
    mocks.turnId = 'turn-midturn'
    mocks.backgroundTasks = [{ id: 'task-monitor', kind: 'monitor', description: 'watcher' }]

    render(claudeSessionView('structured-tab-midturn', 'session-midturn'))

    const status = document.querySelector('[data-native-chat-background-tasks="true"]')
    if (!status) {
      throw new Error('background task status was not rendered during a running turn')
    }
    expect(mocks.composerProps?.isWorking).toBe(true)
    // Dimmed monitor amber is the turn-owns-the-voice treatment.
    expect(status.querySelector('.lucide-activity')?.classList).toContain('text-yellow-500/40')
    fireEvent.click(screen.getByRole('button', { name: '1 monitor — monitoring' }))
    expect(screen.getByText('watcher')).toBeTruthy()
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
      claudeSessionView('structured-tab-concurrent-background', 'session-concurrent-background')
    )
    fireEvent.click(screen.getByRole('button', { name: '2 shells — 2 working' }))
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
    const { rerender } = render(claudeSessionView('structured-tab-stale-background', 'session-old'))
    fireEvent.click(screen.getByRole('button', { name: '1 shell command — working' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop Shared task' }))

    rerender(claudeSessionView('structured-tab-stale-background', 'session-current'))
    // The disclosure is keyed by session, so a new session opens collapsed.
    fireEvent.click(screen.getByRole('button', { name: '1 shell command — working' }))
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

    render(claudeSessionView('structured-tab-taskless-background', 'session-taskless-background'))
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
        isFocusedGroup
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
    mocks.promptItems = claudeGroupedQuestionPromptItems

    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
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
    mocks.promptItems = legacySingleQuestionPromptItems

    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
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
