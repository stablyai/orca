import * as terminalThemeSelection from '../../../../shared/terminal-theme-selection'
import { getDefaultSettings } from '../../../../shared/constants'
// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
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
vi.mock('./use-native-chat-font-size', () => moduleFactories.useNativeChatFontSize())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-tab-owner', () => moduleFactories.useNativeChatTabOwner())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatEmptyState', () => moduleFactories.nativeChatEmptyState())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())

import { NativeChatStructuredSession } from './NativeChatStructuredSession'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import { seededEntry, seedOutbox } from './NativeChatStructuredSession.test-harness'
import { structuredAgentSessionDraftScopeKey } from './native-chat-composer-draft-store'

describe('NativeChatStructuredSession', () => {
  it('applies persisted appearance at the chat root and updates it live', () => {
    const original = useAppStore.getState().settings
    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/tmp'),
        theme: 'dark',
        nativeChatAppearance: {
          fontSize: 18,
          codeFontSize: 11,
          width: 'wide',
          matchTerminalInterface: true,
          contrast: 120
        },
        terminalFontFamily: 'Consolas',
        terminalFontSize: 16,
        terminalColorOverrides: { background: '#112233', foreground: '#ddeeff' }
      }
    })
    const { container } = render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="appearance-tab"
        sessionId="appearance-session"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )
    const root = container.querySelector<HTMLElement>('[data-native-chat-root]')
    expect(root?.style.colorScheme).toBe('dark')
    expect(root?.style.color).toBe('var(--foreground)')
    expect(root?.dataset.nativeChatScheme).toBe('dark')
    expect(root?.style.getPropertyValue('--chat-source-background')).toBe('#112233')
    expect(root?.style.getPropertyValue('--chat-source-foreground')).toBe('#ddeeff')
    expect(root?.style.getPropertyValue('--chat-code-font-family')).toContain('Consolas')
    expect(root?.style.getPropertyValue('--chat-font-family')).toContain('Consolas')
    expect(root?.style.getPropertyValue('--chat-foreground-mix')).toBe('100%')
    expect(root?.style.getPropertyValue('--chat-font-size')).toBe('16px')
    expect(root?.style.getPropertyValue('--chat-code-font-size')).toBe('16px')
    expect(root?.style.getPropertyValue('--chat-content-max-width')).toBe('60rem')
    act(() =>
      useAppStore.setState({
        settings: {
          ...getDefaultSettings('/tmp'),
          theme: 'dark',
          nativeChatAppearance: { width: 'full' }
        }
      })
    )
    expect(root?.style.colorScheme).toBe('')
    expect(root?.style.color).toBe('')
    expect(root?.dataset.nativeChatScheme).toBeUndefined()
    expect(root?.style.getPropertyValue('--chat-source-background')).toBe('')
    expect(root?.style.getPropertyValue('--chat-source-foreground')).toBe('')
    expect(root?.style.getPropertyValue('--chat-font-family')).toBe('')
    expect(root?.style.getPropertyValue('--chat-foreground-mix')).toBe('78%')
    expect(root?.style.getPropertyValue('--chat-font-size')).toBe('14px')
    expect(root?.style.getPropertyValue('--chat-content-max-width')).toBe('none')
    act(() => useAppStore.setState({ settings: original }))
  })

  it('skips appearance work on unrelated settings writes and updates the root for appearance changes', () => {
    const original = useAppStore.getState().settings
    const settings = {
      ...getDefaultSettings('/tmp'),
      theme: 'dark' as const,
      nativeChatAppearance: { matchTerminalInterface: true }
    }
    useAppStore.setState({ settings })
    const resolveColors = vi.spyOn(terminalThemeSelection, 'resolveConfiguredTerminalColors')
    const view = render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="appearance-subscription-tab"
        sessionId="appearance-subscription-session"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )
    const initialResolutions = resolveColors.mock.calls.length
    act(() =>
      useAppStore.setState({
        settings: { ...settings, terminalFontSize: settings.terminalFontSize + 1 }
      })
    )
    expect(resolveColors).toHaveBeenCalledTimes(initialResolutions + 1)
    expect(
      view.container
        .querySelector<HTMLElement>('[data-native-chat-root]')
        ?.style.getPropertyValue('--chat-font-size')
    ).toBe(`${settings.terminalFontSize + 1}px`)
    act(() => useAppStore.setState({ settings: { ...settings, terminalFontFamily: 'Menlo' } }))
    expect(resolveColors).toHaveBeenCalledTimes(initialResolutions + 2)
    expect(
      view.container
        .querySelector<HTMLElement>('[data-native-chat-root]')
        ?.style.getPropertyValue('--chat-code-font-family')
    ).toContain('Menlo')
    view.unmount()
    useAppStore.setState({ settings: original })
  })

  afterEach(() => {
    cleanup()
    resetStructuredSessionMocks()
    vi.restoreAllMocks()
  })

  it("gives the composer this pane shows the conversation's own draft, and Stop returns text there", () => {
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
    const paneKey = structuredAgentSessionPaneKey('structured-tab-1', 'session-1')
    // The pane routes drops and pickers; the draft belongs to the conversation, whatever pane shows it.
    expect(mocks.composerProps).toMatchObject({
      paneKey,
      draftScopeKey: structuredAgentSessionDraftScopeKey('session-1')
    })
    expect(mocks.controllerProps).toMatchObject({
      composerScopeKey: structuredAgentSessionDraftScopeKey('session-1')
    })
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

  // The list defaults to visible, so a dropped prop silently re-arms auto-scroll
  // on reveal and drags a reader who left a hidden pane detached to the bottom.
  it.each([true, false])('tells the transcript the pane is visible: %s', (isVisible) => {
    render(
      <NativeChatStructuredSession
        isVisible={isVisible}
        isFocusedGroup
        tabId="structured-tab-visibility"
        sessionId="session-visibility"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    expect(mocks.messageListProps?.isVisible).toBe(isVisible)
  })

  // The list stops auto-loading on a failed page and re-arms on a new paging
  // generation, so both the page result and the generation must reach it.
  it('hands the list the controller older-history state, generation, and page result', async () => {
    mocks.hasOlder = true
    mocks.loadingOlder = true
    mocks.olderHistoryGeneration = 3
    mocks.loadOlder.mockResolvedValueOnce('failed')
    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-older"
        sessionId="session-older"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    expect(mocks.messageListProps?.session).toMatchObject({
      hasMore: true,
      loadingEarlier: true,
      olderHistoryGeneration: 3
    })
    await expect(mocks.messageListProps?.session?.loadEarlier()).resolves.toBe('failed')
    expect(mocks.loadOlder).toHaveBeenCalledOnce()
  })

  // Transcript image previews shipped Codex-first, and the runtime context they
  // need comes from the tab rather than the agent, so it is never agent-gated.
  it('hands the transcript the image runtime context', () => {
    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-parity"
        sessionId="session-parity"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    expect(mocks.messageListProps?.runtimeContext).not.toBeUndefined()
  })

  it('suppresses live turn activity for a pending question without ending the turn', () => {
    mocks.isWorking = true
    mocks.turnId = 'turn-question'
    mocks.promptItems = legacySingleQuestionPromptItems
    const view = () => (
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-question"
        sessionId="session-question"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )
    const { rerender } = render(view())

    expect(mocks.messageListProps).toMatchObject({
      isWorking: true,
      awaitingInput: 'shown'
    })
    expect(
      document
        .querySelector('[data-native-chat-root="true"]')
        ?.getAttribute('data-native-chat-working')
    ).toBe('true')
    expect(mocks.questionCardProps).not.toBeNull()
    expect(screen.queryByTestId('structured-composer')).toBeNull()

    act(() => mocks.questionCardProps?.onCancel())
    expect(mocks.cancel).toHaveBeenCalledWith('turn-question', {
      itemId: 'legacy-question-item',
      expectedRevision: 1
    })
    expect(mocks.messageListProps?.awaitingInput).toBe('shown')

    mocks.promptItems = []
    rerender(view())
    expect(mocks.messageListProps).toMatchObject({
      isWorking: true,
      awaitingInput: null
    })
    expect(screen.getByTestId('structured-composer')).toBeTruthy()
    expect(mocks.composerProps?.isWorking).toBe(true)
  })

  it('suppresses live turn activity for a pending approval but keeps background work visible', async () => {
    const approvalItems: AgentJournalRenderItem[] = [
      {
        itemId: 'approval-item',
        revision: 1,
        sequence: 1,
        observedAt: 1,
        body: {
          kind: 'approval',
          title: 'Allow command?',
          blockedPath: '/outside/repo/.git/config',
          matchedAskRule: { source: 'projectSettings', toolName: 'Bash' },
          detail: 'pnpm test',
          options: [
            { id: 'allow', label: 'Allow' },
            { id: 'deny', label: 'Deny' }
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
    mocks.isWorking = true
    mocks.turnId = 'turn-approval'
    mocks.promptItems = approvalItems
    mocks.monitoringBackgroundTasks = true

    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-approval"
        sessionId="session-approval"
        target={{ kind: 'local' }}
        agent="claude"
      />
    )

    expect(mocks.messageListProps).toMatchObject({
      isWorking: true,
      awaitingInput: 'shown'
    })
    expect(mocks.approvalCardProps?.approval.title).toBe('Allow command?')
    // The card decides whether to show the path; the ask rule never reaches it.
    expect(mocks.approvalCardProps?.approval.blockedPath).toBe('/outside/repo/.git/config')
    expect(mocks.approvalCardProps?.approval).not.toHaveProperty('matchedAskRule')
    expect(screen.queryByTestId('structured-composer')).toBeNull()
    expect(document.querySelector('[data-native-chat-background-tasks="true"]')).not.toBeNull()

    act(() => mocks.approvalCardProps?.onChoose('allow'))
    expect(mocks.respond).toHaveBeenCalledWith(approvalItems[0], {
      kind: 'option',
      optionId: 'allow'
    })
    await waitFor(() => expect(mocks.revealLatest).toHaveBeenCalledOnce())
    expect(mocks.messageListProps?.awaitingInput).toBe('shown')

    act(() => mocks.approvalCardProps?.onCancel?.())
    expect(mocks.cancel).toHaveBeenCalledWith('turn-approval', {
      itemId: 'approval-item',
      expectedRevision: 1
    })
  })

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

  it('offers Stop before any turn opens when the controller can stop, and stops through it', () => {
    mocks.canStop = true
    render(claudeSessionView('structured-tab-pre-turn', 'session-pre-turn'))

    expect(mocks.composerProps?.isWorking).toBe(true)
    act(() => mocks.composerProps?.onStop?.())
    expect(mocks.stop).toHaveBeenCalledOnce()
    expect(mocks.cancel).not.toHaveBeenCalled()
  })

  it("shows the queue's coming send as a Stop that is not live until a turn can be stopped", () => {
    mocks.queueSendsNext = true
    render(claudeSessionView('structured-tab-sends-next', 'session-sends-next'))
    expect(mocks.composerProps?.isWorking).toBe(true)
    expect(mocks.composerProps?.onStop).toBeUndefined()
  })

  it('hands the composer Resume, on its transport, only while the queue controller offers it', () => {
    const { rerender } = render(claudeSessionView('structured-tab-resume', 'session-resume'))
    expect(mocks.composerProps?.structuredTransport?.queueResume).toBeUndefined()
    mocks.queuedResumable = true
    rerender(claudeSessionView('structured-tab-resume', 'session-resume'))
    act(() => {
      mocks.composerProps?.structuredTransport?.queueResume?.resume()
    })
    expect(mocks.queuedResume).toHaveBeenCalledOnce()
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
      (_sessionId: string, taskId?: string) =>
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
    expect(mocks.respond).toHaveBeenCalledWith(mocks.promptItems[0], {
      kind: 'answers',
      answers: [
        { questionId: 'q1', optionIds: ['target-web', 'target-mobile'] },
        { questionId: 'q2', optionIds: [], other: 'SSH host' }
      ]
    })
  })

  it('answers a single-question item as its one question', () => {
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
    expect(mocks.respond).toHaveBeenLastCalledWith(mocks.promptItems[0], {
      kind: 'answers',
      answers: [{ questionId: 'q1', optionIds: ['q1:choice-2'] }]
    })
    card.onAnswer([{ indices: [], other: ' Svelte ' }])
    expect(mocks.respond).toHaveBeenLastCalledWith(mocks.promptItems[0], {
      kind: 'answers',
      answers: [{ questionId: 'q1', optionIds: [], other: 'Svelte' }]
    })
  })

  // The reader may have scrolled far up; what they just did has to come into view.
  it('brings the latest into view at the press for the submits this pane makes', async () => {
    mocks.promptItems = legacySingleQuestionPromptItems
    const { rerender } = render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-reveal"
        sessionId="session-reveal"
        target={{ kind: 'local' }}
        agent="claude"
      />
    )
    // An answer reveals as it is pressed, before the host decides on it.
    mocks.respond.mockReturnValueOnce(new Promise(() => {}))
    mocks.questionCardProps?.onAnswer([{ indices: [1], other: '' }])
    expect(mocks.respond).toHaveBeenCalledOnce()
    expect(mocks.revealLatest).toHaveBeenCalledOnce()

    mocks.promptItems = []
    rerender(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-reveal"
        sessionId="session-reveal"
        target={{ kind: 'local' }}
        agent="claude"
      />
    )
    const steerQueued = mocks.composerProps?.steerQueued
    const onSubmitted = mocks.composerProps?.structuredTransport?.onSubmitted
    if (!steerQueued || typeof onSubmitted !== 'function') {
      throw new Error('Structured composer was not wired')
    }
    mocks.revealLatest.mockClear()

    // Refused: nothing was steered, so nothing moves.
    expect(steerQueued()).toBe(false)
    expect(mocks.revealLatest).not.toHaveBeenCalled()

    // The composer's sends reveal through its transport.
    onSubmitted()
    expect(mocks.revealLatest).toHaveBeenCalledOnce()
    mocks.queuedSteerNewest.mockReturnValue(true)
    expect(steerQueued()).toBe(true)
    expect(mocks.revealLatest).toHaveBeenCalledTimes(2)
  })

  it('reveals the latest when a delivery notice retries its message', async () => {
    mocks.mode = 'outbox'
    mocks.call.mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'op-head', dispatchState: 'accepted' } }
    })
    seedOutbox('session-retry-reveal', [
      seededEntry('session-retry-reveal', 'op-head', 'first', 'unconfirmed')
    ])
    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-retry-reveal"
        sessionId="session-retry-reveal"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    fireEvent.click(await screen.findByRole('button', { name: /Retry/ }))

    expect(mocks.revealLatest).toHaveBeenCalledOnce()
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
  })

  it("brings the latest into view when a queued card's Steer sends it now", () => {
    mocks.queuedCards = [
      { messageId: 'draft-1', position: 1, text: 'Also check SSH', state: 'waiting', hold: 'turn' }
    ]
    render(
      <TooltipProvider>
        <NativeChatStructuredSession
          isVisible
          isFocusedGroup
          tabId="structured-tab-queue"
          sessionId="session-queue"
          target={{ kind: 'local' }}
          agent="claude"
        />
      </TooltipProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: /Steer/ }))

    expect(mocks.queuedSteer).toHaveBeenCalledWith('draft-1')
    expect(mocks.revealLatest).toHaveBeenCalledOnce()
  })
})
