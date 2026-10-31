// @vitest-environment happy-dom
import {
  mocks,
  projects,
  Draft,
  main,
  submit,
  HostProjection,
  Entry,
  replaceMain
} from './new-thread.test-fixture'
import { navigateDesktopTab } from '@/lib/desktop-navigation'
import { setThreadTestPage } from './thread-page.test-fixture'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useRef } from 'react'
import {
  NativeChatComposer,
  type NativeChatComposerHandle
} from '../native-chat/NativeChatComposer'
import { useNativeChatComposerRevealFocus } from '../native-chat/use-native-chat-composer-reveal-focus'
import { makeUnifiedTab, makeTabGroup } from '@/store/slices/store-test-helpers'

import { launchStructuredAgentFromNewTab } from '@/lib/launch-agent-in-new-tab-structured-route'
import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session-launch-plan'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { selectThread, sendNewThread } from './thread-actions'
import { useAppStore } from '@/store'

import { promptEditor } from '../native-chat/native-chat-prompt-editor.test-support'
import { TooltipProvider } from '../ui/tooltip'

import { StructuredAgentSessionStatusBridge } from '../native-chat/StructuredAgentSessionStatusBridge'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
import { useStructuredSessionSummaries } from '../native-chat/structured-session-summary-store'
import {
  getStructuredLaunchStateBySessionId,
  getPersistedStructuredAgentLaunchRecord
} from '@/lib/agent-session/launch/structured-agent-session-launch-registry'

import { ThreadsSection } from './ThreadsSection'

import { buildAgentLaunchRouteInput } from '@/lib/agent-launch-route-input'
import { useThreadDraft, activeThreadSelection } from './thread-navigation'
import {
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey
} from '../native-chat/native-chat-composer-draft-store'
import { resetStructuredAgentLaunchRegistryForTests } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { drawTabsFromMain } from '@/store/slices/tabs-drawn-from-main.test-fixture'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/structured-agent-session-launch-errors'
import type * as LaunchModule from '@/lib/structured-agent-session-launch-create-call'

it('renders real first-send agent/model and permission controls and captures explicit aliases without catalog confirmation', async () => {
  const admission = Promise.withResolvers<{ kind: 'admitted' }>()
  const creation =
    Promise.withResolvers<Awaited<ReturnType<typeof LaunchModule.launchStructuredAgentSession>>>()
  mocks.launch.mockImplementation(async (intent) => {
    await Promise.resolve()
    intent.createMessageSupport = true
    intent.prepareCreate?.(true)
    intent.createPrepared = true
    return creation.promise
  })
  mocks.support.mockReturnValue(admission.promise)
  const view = render(<Draft />)
  expect(screen.getByRole('button', { name: /Agent Opus/ })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Agent Opus/ }))
  expect(screen.getByRole('option', { name: /Codex/ }).textContent).toContain('gpt-5.5')
  fireEvent.click(screen.getByRole('option', { name: /Claude/ }))
  // A real explicit model selection uses the shared draft editor; missing model lists do not gate Send.
  fireEvent.click(screen.getByRole('button', { name: /Agent Opus/ }))
  const model = screen.getAllByRole('option').find((node) => node.textContent === 'Opus 1M')
  if (!model) {
    throw new Error('curated Opus model missing')
  }
  fireEvent.click(model)
  const permission = screen.getByRole('button', { name: /Ask/ })
  fireEvent.pointerDown(permission, { button: 0, ctrlKey: false })
  const approve = screen.getByRole('menuitemradio', { name: /Approve for me/ })
  fireEvent.click(approve)
  mocks.inventory.mockReturnValue([])
  view.rerender(<Draft />)
  const menuTarget = mocks.menu.mock.calls.at(-1)?.[0]
  expect(
    buildAgentLaunchRouteInput(useAppStore.getState(), {
      agent: 'claude',
      workspace: menuTarget.workspace
    }).executionHostId
  ).toBe('local')
  const composer = await submit()
  expect(composer.textContent).toBe('')
  fireEvent.click(screen.getByRole('button', { name: 'Choose project' }))
  fireEvent.click(screen.getByRole('option', { name: 'B' }))
  await act(async () => {
    admission.resolve({ kind: 'admitted' })
    await main.settle()
  })
  await waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce())
  expect(mocks.launch.mock.calls[0][0]).toMatchObject({
    agent: 'claude',
    params: { surface: 'thread' },
    explicitLaunchOptions: { model: 'opus[1m]', permissionMode: 'auto' }
  })
  await act(async () =>
    creation.reject(
      new StructuredAgentSessionCreateRefusalError('structured_agent_session_unsupported')
    )
  )
  await waitFor(() => expect(composer.getAttribute('contenteditable')).toBe('true'))
  expect(composer.textContent).toBe('')
})
it.each(['before', 'after'] as const)(
  'production %s-admission failure keeps exactly one recoverable prompt and preserves project navigation',
  async (phase) => {
    const admission = Promise.withResolvers<{ kind: 'admitted' | 'declined' }>()
    const creation =
      Promise.withResolvers<Awaited<ReturnType<typeof LaunchModule.launchStructuredAgentSession>>>()
    mocks.support.mockReturnValue(admission.promise)
    mocks.launch.mockImplementation(async (intent) => {
      await Promise.resolve()
      intent.createMessageSupport = true
      intent.prepareCreate?.(true)
      intent.createPrepared = true
      return creation.promise
    })
    render(<Draft />)
    const composer = await submit()
    fireEvent.click(screen.getByRole('button', { name: 'Choose project' }))
    fireEvent.click(screen.getByRole('option', { name: 'B' }))
    await act(async () => {
      admission.resolve({ kind: phase === 'before' ? 'declined' : 'admitted' })
      await main.settle()
    })
    if (phase === 'after') {
      await waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce())
      await act(async () =>
        creation.reject(
          new StructuredAgentSessionCreateRefusalError('structured_agent_session_unsupported')
        )
      )
    }
    await waitFor(() => expect(composer.getAttribute('contenteditable')).toBe('true'))
    expect(screen.getByRole('button', { name: 'Choose project' }).textContent).toBe('B')
    const tabs = Object.values(useAppStore.getState().unifiedTabsByWorktree)
      .flat()
      .filter((tab) => tab.contentType === 'agent-session')
    expect(tabs).toHaveLength(phase === 'after' ? 1 : 0)
    expect(composer.textContent).toBe(phase === 'before' ? 'Preserve prompt' : '')
    if (phase === 'after') {
      expect(
        readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(tabs[0].entityId)).text
      ).toBe('Preserve prompt')
    }
    expect(readNativeChatComposerDraft('thread-draft:main').text).toBe(
      phase === 'before' ? 'Preserve prompt' : ''
    )
  }
)

it('promotes a same-project draft after an equivalent selection object was replaced, through production onOpened', async () => {
  const admission = Promise.withResolvers<{ kind: 'admitted' }>()
  const creation =
    Promise.withResolvers<Awaited<ReturnType<typeof LaunchModule.launchStructuredAgentSession>>>()
  mocks.support.mockReturnValue(admission.promise)
  mocks.launch.mockImplementation(async (intent) => {
    await Promise.resolve()
    intent.createMessageSupport = true
    intent.prepareCreate?.(true)
    intent.createPrepared = true
    return creation.promise
  })
  render(<Draft />)
  await submit()
  act(() => useThreadDraft.setState({ draft: { ...useThreadDraft.getState().draft! } }))
  await act(async () => {
    admission.resolve({ kind: 'admitted' })
    await main.settle()
  })
  await waitFor(() => expect(screen.getByText('Opened conversation')).toBeTruthy())
  expect(activeThreadSelection(useAppStore.getState())).toBeNull()
  const tab = Object.values(useAppStore.getState().unifiedTabsByWorktree).flat()[0]
  expect(
    useAppStore.getState().groupsByWorktree[tab.worktreeId].find((g) => g.id === tab.groupId)
      ?.activeTabId
  ).toBe(tab.id)
  await act(async () =>
    creation.reject(
      new StructuredAgentSessionCreateRefusalError('structured_agent_session_unsupported')
    )
  )
})
it.each(['plus', 'shortcut'] as const)(
  'focuses the actual composer from %s after delayed capabilities',
  async (entry) => {
    mocks.loading = true
    setThreadTestPage({ selection: null })
    const view = render(<Entry />)
    if (entry === 'plus') {
      fireEvent.click(screen.getByRole('button', { name: 'New thread' }))
    } else {
      fireEvent.keyDown(window, { key: 'n', code: 'KeyN', metaKey: true, altKey: true })
    }
    const composer = await screen.findByRole('textbox', {
      name: 'Ask for changes, or ask anything about this project'
    })
    expect(document.activeElement).not.toBe(composer)
    mocks.loading = false
    view.rerender(<Entry />)
    await waitFor(() => expect(document.activeElement).toBe(composer))
    expect(mocks.support).not.toHaveBeenCalled()
    expect(mocks.launch).not.toHaveBeenCalled()
  }
)

it('an existing chat activation focuses the actual composer through the normal activation owner', async () => {
  const tab = makeUnifiedTab({
    id: 'selected-chat',
    entityId: 'selected-session',
    worktreeId: projects[0].worktree.id,
    groupId: 'selected-group',
    contentType: 'agent-session',
    agentSessionAgent: 'claude',
    executionHostId: 'local'
  })
  useAppStore.setState({
    unifiedTabsByWorktree: { [tab.worktreeId]: [tab] },
    groupsByWorktree: {
      [tab.worktreeId]: [
        makeTabGroup({
          id: tab.groupId,
          worktreeId: tab.worktreeId,
          activeTabId: tab.id,
          tabOrder: [tab.id]
        })
      ]
    },
    activeGroupIdByWorktree: { [tab.worktreeId]: tab.groupId }
  })
  function Chat() {
    const root = useRef<HTMLDivElement>(null)
    const composer = useRef<NativeChatComposerHandle>(null)
    useNativeChatComposerRevealFocus({
      tabId: tab.id,
      rootRef: root,
      composerRef: composer,
      isVisible: true,
      isFocusedGroup: true,
      composerReady: true
    })
    return (
      <div ref={root}>
        <TooltipProvider>
          <NativeChatComposer
            ref={composer}
            terminalTabId={tab.id}
            paneKey={`${tab.id}:root`}
            targetPtyId={null}
            agent="claude"
            canSend
            structuredTransport={{
              capturePresentation: () => () => true,
              dispatchCommand: async () => ({ handled: false, accepted: false, error: null }),
              send: () => true,
              optionsSurface: {
                getSnapshot: () => [],
                setOption: async () => ({ snapshot: [] }),
                invokeAction: async () => ({ snapshot: [] }),
                subscribe: () => () => {}
              },
              optionSnapshot: [],
              acceptsImages: false,
              onError: () => {},
              runtime: 'local',
              runtimeEnvironmentId: null,
              sessionId: tab.entityId
            }}
          />
        </TooltipProvider>
        <button>Other control</button>
      </div>
    )
  }
  render(<Chat />)
  const composer = screen.getByRole('textbox')
  await waitFor(() => expect(document.activeElement).toBe(composer))
  screen.getByRole('button', { name: 'Other control' }).focus()
  act(() => selectThread(tab))
  await waitFor(() => expect(document.activeElement).toBe(composer))
  expect(activeThreadSelection(useAppStore.getState())).toBeNull()
})

it.each(['declined', 'admitted'] as const)(
  'preserves existing explicit-chat admission inputs and refusal policy on the thread path: %s',
  async (answer) => {
    mocks.support.mockResolvedValue({ kind: answer })
    mocks.launch.mockRejectedValue(
      new StructuredAgentSessionCreateRefusalError('structured_agent_session_unsupported')
    )
    const openTerminal = vi.fn(() => null)
    const launchOptions = { model: 'opus[1m]', permissionMode: 'ask' }
    render(
      <>
        <StructuredAgentSessionStatusBridge />
        <HostProjection />
      </>
    )
    const ordinary = launchStructuredAgentFromNewTab({
      plan: adoptAgentSessionLaunchVerdict({
        route: 'structured-native-chat',
        requestedSurface: 'chat',
        requestId: newAgentLaunchRequestId(),
        worktreeId: projects[0].worktree.id,
        executionHostId: 'local',
        agent: 'claude',
        prompt: 'Preserve prompt',
        promptDelivery: 'auto-submit',
        launchOptions
      }),
      worktreeId: projects[0].worktree.id,
      openTerminal
    })
    if (!ordinary) {
      throw new Error('ordinary explicit chat was not launched')
    }
    expect((await ordinary.structuredSettlement).kind).toBe('failed')
    await act(async () => main.settle())
    const ordinaryTab = Object.values(useAppStore.getState().unifiedTabsByWorktree).flat()[0]
    if (ordinaryTab) {
      expect(useStructuredSessionSummaries.getState().threadTabIds.has(ordinaryTab.id)).toBe(false)
      expect(screen.getByTestId('host-projection').textContent).toBe(ordinaryTab.id)
    }
    const admission = mocks.support.mock.calls[0]
    const ordinaryInput = mocks.launch.mock.calls[0]?.[0]
    mocks.support.mockClear()
    mocks.launch.mockClear()
    const thread = sendNewThread(projects[0], 'Preserve prompt', { agent: 'claude', launchOptions })
    if (!thread) {
      throw new Error('thread was not launched')
    }
    expect((await thread.settlement).kind).toBe('failed')
    await main.settle()
    expect(mocks.support.mock.calls[0]).toEqual(admission)
    expect(openTerminal).not.toHaveBeenCalled()
    if (answer === 'declined') {
      expect(mocks.launch).not.toHaveBeenCalled()
      expect(Object.values(useAppStore.getState().unifiedTabsByWorktree).flat()).toEqual([])
    } else {
      const input = mocks.launch.mock.calls[0][0]
      expect(input).toMatchObject({
        agent: ordinaryInput.agent,
        worktreeId: ordinaryInput.worktreeId,
        target: ordinaryInput.target,
        explicitLaunchOptions: ordinaryInput.explicitLaunchOptions,
        params: { surface: 'thread' }
      })
      expect(ordinaryInput.params.surface).toBeUndefined()
    }
  }
)

it.each([true, false])(
  'retains logical draft launch choices through real Settings Back (edited=%s)',
  async (edited) => {
    mocks.launch.mockRejectedValue(
      new StructuredAgentSessionCreateRefusalError('structured_agent_session_unsupported')
    )
    if (!edited) {
      useAppStore.setState({
        settings: { ...useAppStore.getState().settings!, defaultTuiAgent: 'codex' }
      })
    }
    render(<Draft />)
    if (edited) {
      fireEvent.click(screen.getByRole('button', { name: /Agent Opus/ }))
      fireEvent.click(screen.getByRole('option', { name: /Codex/ }))
      fireEvent.click(screen.getByRole('button', { name: /Agent gpt/ }))
      fireEvent.click(screen.getAllByRole('option').find((node) => node.textContent === 'Opus 1M')!)
      fireEvent.pointerDown(screen.getByRole('button', { name: /Ask/ }), {
        button: 0,
        ctrlKey: false
      })
      fireEvent.click(screen.getByRole('menuitemradio', { name: /Approve for me/ }))
    }
    const composer = screen.getByRole('textbox', { name: /Ask for changes/ })
    act(() => promptEditor(composer).commands.insertContent('P through Settings'))
    act(() => useAppStore.getState().openSettingsPage())
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Settings Back' }))
    expect(screen.getByRole('button', { name: edited ? /Agent Opus/ : /Agent gpt/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: edited ? /Approve for me/ : /Ask/ })).toBeTruthy()
    const restored = screen.getByRole('textbox', { name: /Ask for changes/ })
    expect(restored.textContent).toBe('P through Settings')
    fireEvent.keyDown(restored, { key: 'Enter' })
    await waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce())
    expect(mocks.launch.mock.calls[0][0]).toMatchObject({
      agent: 'codex',
      explicitLaunchOptions: edited ? { model: 'opus[1m]', permissionMode: 'auto' } : undefined
    })
    // A different logical draft follows preferences instead of inheriting these edits.
    act(() =>
      setThreadTestPage({
        selection: { kind: 'new', projectKey: projects[0].key, draftId: 'unrelated' }
      })
    )
    expect(screen.getByRole('button', { name: edited ? /Agent Opus/ : /Agent gpt/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Ask/ })).toBeTruthy()
  }
)

it.each(['refused', 'published', 'unknown'] as const)(
  'keeps a production admitted thread classified through %s and canonical handoff/retirement',
  async (outcome) => {
    const creation =
      Promise.withResolvers<Awaited<ReturnType<typeof LaunchModule.launchStructuredAgentSession>>>()
    mocks.launch.mockImplementation(async (intent) => {
      await Promise.resolve()
      intent.createMessageSupport = true
      intent.prepareCreate?.(true)
      intent.createPrepared = true
      return creation.promise
    })
    const view = render(
      <TooltipProvider>
        <StructuredAgentSessionStatusBridge />
        <Draft />
        <ThreadsSection />
        <HostProjection />
      </TooltipProvider>
    )
    await submit()
    await act(async () => {
      await main.settle()
    })
    await waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce())
    const tab = Object.values(useAppStore.getState().unifiedTabsByWorktree).flat()[0]
    expect(screen.getByTestId('selected-thread').textContent).toBe(tab.entityId)
    expect(
      useStructuredSessionSummaries.getState().byWorktree.get(tab.worktreeId)?.has(tab.id)
    ).toBe(true)
    expect(screen.getByRole('button', { name: /Claude Chat/ })).toBeTruthy()
    expect(screen.getByTestId('host-projection').textContent).toBe('')
    await act(async () => {
      if (outcome === 'unknown') {
        creation.reject(new Error('connection lost'))
      } else if (outcome === 'refused') {
        creation.reject(
          new StructuredAgentSessionCreateRefusalError('structured_agent_session_unsupported')
        )
      } else {
        const message = mocks.launch.mock.calls[0][0].params.firstMessage
        creation.resolve({
          sessionId: tab.entityId,
          fence: 1,
          firstMessage: {
            clientMessageId: message.clientMessageId,
            fence: 1,
            payloadFingerprint: 'created-message',
            dispatchState: 'accepted',
            providerItemId: null,
            reason: null,
            submittedAt: 1,
            resolvedAt: null
          },
          cursor: { epoch: 'created', sequence: 1 }
        })
      }
    })
    if (outcome === 'unknown') {
      await waitFor(() =>
        expect(getStructuredLaunchStateBySessionId(tab.entityId)?.visibilityUnknown).toBe(true)
      )
    }
    if (outcome === 'published') {
      await waitFor(() => expect(getStructuredLaunchStateBySessionId(tab.entityId)).toBeUndefined())
    }
    expect(screen.getByTestId('selected-thread').textContent).toBe(tab.entityId)
    // A successful receipt can clean up before the status feed ever lists this session.
    const emit = mocks.subscribe.mock.calls[0][1]
    if (outcome === 'published') {
      act(() =>
        emit({
          type: 'snapshot',
          sessions: [
            {
              sessionId: tab.entityId,
              workspaceId: tab.worktreeId,
              agent: 'claude',
              status: 'idle',
              latestPrompt: 'P',
              updatedAt: 3,
              surface: 'thread',
              conversationName: 'Published thread'
            }
          ]
        })
      )
      expect(screen.getAllByText('Published thread').length).toBeGreaterThan(0)
    }
    view.unmount()
    if (outcome !== 'published') {
      expect(getPersistedStructuredAgentLaunchRecord(tab.entityId)).toMatchObject({
        surface: 'thread',
        sessionId: tab.entityId,
        executionHostId: 'local'
      })
      resetStructuredAgentLaunchRegistryForTests()
      resetStructuredAgentSessionStatusFeedsForTests()
      // Reload the projection owner from the real retained persisted launch, with no status snapshot.
      render(
        <>
          <StructuredAgentSessionStatusBridge />
          <Draft />
        </>
      )
      expect(screen.getByTestId('selected-thread').textContent).toBe(tab.entityId)
    }
    await act(async () => {
      useAppStore.getState().closeUnifiedTab(tab.id)
      await main.settle()
    })
    expect(useStructuredSessionSummaries.getState().threadTabIds.has(tab.id)).toBe(false)
  }
)

it('newer same-id explicit navigation fences the real delayed onOpened completion', async () => {
  const existing = makeUnifiedTab({
    id: 'existing',
    entityId: 'selected',
    worktreeId: projects[0].worktree.id,
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    executionHostId: 'local',
    groupId: 'existing-group'
  })
  useAppStore.setState({
    unifiedTabsByWorktree: { [existing.worktreeId]: [existing] },
    groupsByWorktree: {
      [existing.worktreeId]: [
        makeTabGroup({
          id: 'existing-group',
          worktreeId: existing.worktreeId,
          tabOrder: [existing.id],
          activeTabId: existing.id
        })
      ]
    },
    activeGroupIdByWorktree: { [existing.worktreeId]: 'existing-group' }
  })
  main.close()
  replaceMain(await drawTabsFromMain(useAppStore))
  const admission = Promise.withResolvers<{ kind: 'admitted' }>()
  mocks.support.mockReturnValue(admission.promise)
  mocks.launch.mockRejectedValue(
    new StructuredAgentSessionCreateRefusalError('structured_agent_session_unsupported')
  )
  render(<Draft />)
  await submit()
  act(() => navigateDesktopTab(existing.id, { worktreeId: existing.worktreeId }))
  await act(async () => {
    admission.resolve({ kind: 'admitted' })
    await main.settle()
  })
  await waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce())
  expect(useAppStore.getState().getActiveTab(existing.worktreeId)?.id).toBe(existing.id)
  expect(activeThreadSelection(useAppStore.getState())).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
})
