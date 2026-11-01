/**
 * @vitest-environment happy-dom
 */
import React, { createRef, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as I18n from '@/i18n/i18n'
import type { AppState } from '@/store'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import type { NativeChatComposerHandle } from './NativeChatComposer'
import { nativeChatPaneHeader } from './NativeChatPaneHeader'
import { emptyNativeChatContextMenuActions } from './use-native-chat-context-menu'
import { useNativeChatHandOff } from './use-native-chat-hand-off'
import { useStructuredNativeChatPaneCommands } from './use-structured-native-chat-pane-commands'

type ItemProps = { disabled?: boolean; onSelect?: () => void; children?: ReactNode }

const items = vi.hoisted(() => ({ list: [] as ItemProps[] }))
const callRuntimeRpc = vi.hoisted(() => vi.fn())
const handOff = vi.hoisted(() => ({
  options: vi.fn(),
  capability: vi.fn(),
  dialog: vi.fn(),
  focus: vi.fn(),
  error: vi.fn()
}))

const paneActions = vi.hoisted(() => ({
  onSplitRight: vi.fn(() => true),
  onSplitDown: vi.fn(() => true),
  canClosePane: true,
  closeLabel: 'Close Pane',
  onClosePane: vi.fn()
}))
const store = vi.hoisted(() => ({
  keybindings: {},
  groupsByWorktree: { 'worktree-1': [{ id: 'group-1' }] }
}))

vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: ReactNode }) => children
  return {
    DropdownMenu: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuItem: (props: ItemProps) => {
      items.list.push(props)
      return props.children
    },
    DropdownMenuLabel: Pass,
    DropdownMenuSeparator: () => null,
    DropdownMenuShortcut: Pass,
    DropdownMenuSub: Pass,
    DropdownMenuSubContent: Pass,
    DropdownMenuSubTrigger: Pass,
    DropdownMenuTrigger: Pass
  }
})
vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18n>()),
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: handOff.error } }))
vi.mock('@/components/ui/tooltip', () => {
  const Pass = ({ children }: { children?: ReactNode }) => children
  return { Tooltip: Pass, TooltipTrigger: Pass, TooltipContent: () => null }
})
vi.mock('@/components/tab-bar/TabWorkspaceLayoutMenuSection', () => ({
  TabWorkspaceLayoutMenuSection: () => null
}))
vi.mock('@/components/tab-bar/tab-move-to-pane-column', () => ({
  canMoveTabToNewPaneColumn: () => false
}))
vi.mock('./use-structured-chat-pane-actions', () => ({
  useStructuredChatPaneActions: () => paneActions
}))
vi.mock('./NativeChatResumeInCliButton', () => ({ NativeChatResumeInCliButton: () => null }))
vi.mock('@/store', () => ({
  useAppStore: (
    select: (state: Pick<AppState, 'keybindings' | 'unifiedTabsByWorktree'>) => unknown
  ) => select({ ...store, unifiedTabsByWorktree: {} })
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: handOff.options,
  supportsStructuredAgentSessionContinuationContext: handOff.capability
}))
vi.mock('@/runtime/structured-conversation-name', () => ({
  useStructuredChatTabConversationName: () => 'Fix the login bug'
}))
vi.mock('@/components/agent-session-continuation/AgentSessionContinuationDialog', () => ({
  AgentSessionContinuationDialog: (props: {
    request: AgentSessionContinuationRequest | null
    onOpenChange: (open: boolean) => void
  }) => {
    handOff.dialog(props)
    return <button onClick={() => props.onOpenChange(false)}>Close hand-off</button>
  }
}))
vi.mock('../../runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  callRuntimeRpc
}))

const SESSION = '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'
const TARGET = { kind: 'environment', environmentId: 'env_1' } as const

function childrenText(children: ReactNode): string {
  return React.Children.toArray(children)
    .map((child) =>
      typeof child === 'string'
        ? child
        : React.isValidElement<{ children?: ReactNode }>(child)
          ? childrenText(child.props.children)
          : ''
    )
    .join('')
}

function StructuredChatTab({
  inWorkspace = false,
  epoch = 'epoch',
  visible = true,
  fallback = false,
  terminalPane = false,
  owner = 'worktree-1'
}: {
  inWorkspace?: boolean
  epoch?: string
  visible?: boolean
  fallback?: boolean
  terminalPane?: boolean
  owner?: string | null
}): ReactNode {
  const pane = {
    tabId: 'chat-tab',
    groupId: 'group-1',
    isVisible: visible,
    isFocusedGroup: true,
    sessionId: SESSION,
    target: TARGET,
    agent: 'codex' as const,
    ...(terminalPane
      ? {
          contextMenuActions: {
            ...emptyNativeChatContextMenuActions,
            canContinueAgentSessionInNewSession: true
          }
        }
      : {})
  }
  const handOffState = useNativeChatHandOff({
    pane,
    directory: inWorkspace
      ? { worktreeId: 'wt-1', worktreePath: '/work/repo', runtimeEnvironmentId: 'env_1' }
      : null,
    messages: fallback
      ? [
          {
            id: 'recent',
            role: 'user',
            timestamp: 1,
            source: 'transcript',
            blocks: [{ type: 'text', text: 'Keep the task context' }]
          },
          {
            id: 'start',
            role: 'system',
            timestamp: 2,
            source: 'transcript',
            agentStart: true,
            blocks: [{ type: 'text', text: 'Do not export this worker assignment' }]
          },
          {
            id: 'answer',
            role: 'assistant',
            timestamp: 3,
            source: 'transcript',
            blocks: [{ type: 'text', text: 'Keep the answer' }]
          }
        ]
      : [],
    epoch,
    focusComposer: handOff.focus
  })
  const { menu } = useStructuredNativeChatPaneCommands({
    pane,
    handOff: handOffState,
    ownerWorktreeId: owner,
    rootRef: createRef<HTMLDivElement>(),
    composerRef: createRef<NativeChatComposerHandle>(),
    questionAnswerInputRef: createRef<HTMLInputElement>(),
    ...(inWorkspace
      ? {
          fileLinkContext: {
            worktreeId: 'wt-1',
            worktreePath: '/work/repo',
            runtimeEnvironmentId: 'env_1'
          }
        }
      : {})
  })
  return (
    <>
      {nativeChatPaneHeader(pane, owner, 'dark', handOffState)}
      {menu}
      {handOffState.dialog}
    </>
  )
}

describe('a structured chat tab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.groupsByWorktree['worktree-1'] = [{ id: 'group-1' }]
    handOff.capability.mockResolvedValue(true)
    items.list = []
    callRuntimeRpc.mockReset().mockResolvedValue({ orcaSessionId: `orca_session_id:${SESSION}` })
    Object.assign(window, {
      api: { ui: { writeClipboardText: vi.fn().mockResolvedValue(undefined) } }
    })
  })

  it.each([false, true])('uses the header commands with split panes: %s', (split) => {
    if (split) {
      store.groupsByWorktree['worktree-1'].push({ id: 'group-2' })
    }
    const markup = renderToStaticMarkup(<StructuredChatTab />)
    expect(markup).not.toContain('Move Tab to Split')
    expect(markup).not.toContain('Resume in New CLI')
    expect(markup).not.toContain('Continue with Terminal Agent')
    for (const [label, command] of [
      ['Split Chat Right', paneActions.onSplitRight],
      ['Split Chat Down', paneActions.onSplitDown]
    ] as const) {
      const item = items.list.find((entry) => childrenText(entry.children).startsWith(label))
      expect(item).toBeDefined()
      item?.onSelect?.()
      expect(command).toHaveBeenCalledOnce()
    }
    const close = items.list.find((entry) => childrenText(entry.children) === 'Close Pane')
    expect(Boolean(close)).toBe(split)
    close?.onSelect?.()
    expect(paneActions.onClosePane).toHaveBeenCalledTimes(split ? 1 : 0)
  })

  it.each([null, ''])('keeps the session-ID fallback without a known owner: %s', (owner) => {
    const markup = renderToStaticMarkup(<StructuredChatTab owner={owner} />)
    expect(markup).not.toContain('Split Chat')
    expect(markup).toContain('Copy Orca Session ID')
  })

  it("offers Copy Orca Session ID, asking the tab's host for this session's Orca session ID", async () => {
    renderToStaticMarkup(<StructuredChatTab />)

    const item = items.list.find(
      (candidate) => childrenText(candidate.children) === 'Copy Orca Session ID'
    )
    item?.onSelect?.()

    expect(item).toBeDefined()
    await vi.waitFor(() =>
      expect(callRuntimeRpc).toHaveBeenCalledWith(TARGET, 'orchestration.sessionAddress', {
        sessionId: SESSION
      })
    )
  })

  it('keeps header and menu hand-off requests, disabled states and empty-source failures identical', async () => {
    const requests: AgentSessionContinuationRequest[] = []
    const label = 'Hand Off to Another Agent'
    const menuItem = () =>
      items.list.findLast((candidate) => childrenText(candidate.children) === label)
    const expectDisabled = (disabled: boolean) => {
      expect(screen.getByRole('button', { name: label }).hasAttribute('disabled')).toBe(disabled)
      expect(menuItem()?.disabled).toBe(disabled)
    }
    for (const entry of ['header', 'menu'] as const) {
      vi.clearAllMocks()
      items.list = []
      const saved = Promise.withResolvers<{
        status: 'current'
        capturedText: string
        transcriptPath: string
      }>()
      handOff.options.mockReturnValue(saved.promise)
      const view = render(<StructuredChatTab fallback />)
      expect(screen.queryByRole('button', { name: label })).toBeNull()
      expect(menuItem()).toBeUndefined()
      view.rerender(<StructuredChatTab inWorkspace fallback />)
      expectDisabled(false)
      const open = () =>
        entry === 'header'
          ? fireEvent.click(screen.getByRole('button', { name: label }))
          : openMenuHandOff()
      await act(async () => open())
      expect(handOff.options).toHaveBeenCalledExactlyOnceWith(
        TARGET,
        'agentSession.continuationContext',
        {
          sessionId: SESSION,
          workspaceId: 'wt-1',
          expectedCursor: { epoch: 'epoch', sequence: 0 }
        }
      )
      expect(handOff.dialog.mock.lastCall?.[0].request).toBeNull()
      expectDisabled(true)
      await act(async () =>
        saved.resolve({
          status: 'current',
          capturedText: 'Saved chat context',
          transcriptPath: '/work/codex.jsonl'
        })
      )
      requests.push(handOff.dialog.mock.lastCall?.[0].request)
      expectDisabled(true)
      fireEvent.click(screen.getByText('Close hand-off'))
      expectDisabled(false)
      handOff.options.mockResolvedValue({ status: 'current', capturedText: '' })
      await act(async () => open())
      expect(screen.queryByText('Close hand-off')).toBeNull()
      expect(handOff.error).toHaveBeenCalledExactlyOnceWith(
        'No session context is available to continue in a new session.'
      )
      expect(handOff.focus).toHaveBeenCalledOnce()
      expectDisabled(false)
      view.unmount()
    }
    expect(requests[0]).toEqual({
      source: {
        sourceKind: 'chat',
        sourceAgent: 'codex',
        sourceTitle: 'Fix the login bug',
        sourceWorkingDirectory: '/work/repo',
        capturedText: 'Saved chat context',
        transcriptPath: '/work/codex.jsonl'
      },
      worktreeId: 'wt-1',
      workspacePath: '/work/repo',
      initialCwd: '/work/repo',
      groupId: 'group-1',
      launchSource: 'native_chat'
    })
    expect(requests[1]).toEqual(requests[0])
  })

  it('keeps exactly the terminal pane hand-off row when chat shares that pane', () => {
    renderToStaticMarkup(<StructuredChatTab inWorkspace terminalPane />)
    expect(
      items.list.filter(
        (candidate) => childrenText(candidate.children) === 'Hand Off to Another Agent'
      )
    ).toHaveLength(1)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })
  function openMenuHandOff() {
    const item = items.list.findLast(
      (candidate) => childrenText(candidate.children) === 'Hand Off to Another Agent'
    )
    expect(item).toBeDefined()
    item?.onSelect?.()
  }
  it('retires menu preparation on dismiss and incoming source changes', async () => {
    const delayed = Promise.withResolvers<{
      status: 'current'
      capturedText: string
      transcriptPath: string
    }>()
    handOff.options.mockReturnValue(delayed.promise)
    const view = render(<StructuredChatTab inWorkspace />)
    await act(async () => openMenuHandOff())
    fireEvent.click(screen.getByText('Close hand-off'))
    await act(async () =>
      delayed.resolve({
        status: 'current',
        capturedText: 'Saved chat context',
        transcriptPath: '/discarded.jsonl'
      })
    )
    expect(screen.queryByText('Close hand-off')).toBeNull()
    const historical = Promise.withResolvers<{
      status: 'current'
      capturedText: string
      transcriptPath: string
    }>()
    handOff.options.mockReturnValue(historical.promise)
    await act(async () => openMenuHandOff())
    view.rerender(<StructuredChatTab inWorkspace />)
    expect(handOff.dialog.mock.lastCall?.[0].request).toBeNull()
    expect(
      items.list.findLast((item) => childrenText(item.children) === 'Hand Off to Another Agent')
        ?.disabled
    ).toBe(true)
    await act(async () =>
      historical.resolve({
        status: 'current',
        capturedText: 'Saved chat context',
        transcriptPath: '/historical.jsonl'
      })
    )
    await screen.findByText('Close hand-off')
    view.rerender(<StructuredChatTab inWorkspace />)
    expect(screen.getByText('Close hand-off')).toBeDefined()
    fireEvent.click(screen.getByText('Close hand-off'))
    const superseded = Promise.withResolvers<{
      status: 'current'
      capturedText: string
      transcriptPath: string
    }>()
    handOff.options.mockReturnValue(superseded.promise)
    await act(async () => openMenuHandOff())
    view.rerender(<StructuredChatTab inWorkspace epoch="replacement" />)
    await act(async () =>
      superseded.resolve({
        status: 'current',
        capturedText: 'Saved chat context',
        transcriptPath: '/superseded.jsonl'
      })
    )
    expect(screen.queryByText('Close hand-off')).toBeNull()
    view.rerender(<StructuredChatTab inWorkspace />)
    handOff.options.mockResolvedValue({
      status: 'current',
      capturedText: 'Saved chat context',
      transcriptPath: '/current.jsonl'
    })
    await act(async () => openMenuHandOff())
    await screen.findByText('Close hand-off')
    view.rerender(<StructuredChatTab inWorkspace visible={false} />)
    view.rerender(<StructuredChatTab inWorkspace />)
    expect(screen.queryByText('Close hand-off')).toBeNull()
    await act(async () => openMenuHandOff())
    fireEvent.click(screen.getByText('Close hand-off'))
    const capability = Promise.withResolvers<boolean>()
    handOff.capability.mockReturnValue(capability.promise)
    await act(async () => openMenuHandOff())
    handOff.options.mockClear()
    view.unmount()
    await act(async () => capability.resolve(true))
    expect(handOff.options).not.toHaveBeenCalled()
  })
  it('falls back for an old host, reports empty context and discards superseded fallback', async () => {
    handOff.capability.mockResolvedValue(false)
    const view = render(<StructuredChatTab inWorkspace />)
    await act(async () => openMenuHandOff())
    expect(handOff.options).not.toHaveBeenCalled()
    expect(handOff.error).toHaveBeenCalledOnce()
    expect(handOff.focus).toHaveBeenCalledOnce()
    view.rerender(<StructuredChatTab inWorkspace fallback />)
    await act(async () => openMenuHandOff())
    expect(handOff.dialog.mock.lastCall?.[0].request.source).toMatchObject({
      capturedText: 'user: Keep the task context\n\nassistant: Keep the answer',
      transcriptPath: undefined
    })
    fireEvent.click(screen.getByText('Close hand-off'))
    handOff.capability.mockResolvedValue(true)
    handOff.options.mockResolvedValue({ status: 'current', transcriptPath: '/native.jsonl' })
    await act(async () => openMenuHandOff())
    expect(handOff.dialog.mock.lastCall?.[0].request.source).toMatchObject({
      capturedText: 'user: Keep the task context\n\nassistant: Keep the answer',
      transcriptPath: undefined
    })
    fireEvent.click(screen.getByText('Close hand-off'))
    handOff.options.mockResolvedValue({ status: 'current', capturedText: '' })
    await act(async () => openMenuHandOff())
    expect(screen.queryByText('Close hand-off')).toBeNull()
    expect(handOff.error).toHaveBeenCalledTimes(2)
    handOff.options.mockResolvedValue({ status: 'superseded' })
    await act(async () => openMenuHandOff())
    expect(screen.queryByText('Close hand-off')).toBeNull()
  })
  it.each([false, true])(
    'retires a deadline click with useful fallback=%s before another click',
    async (fallback) => {
      vi.useFakeTimers()
      const expired = Promise.withResolvers<boolean>()
      const current = Promise.withResolvers<boolean>()
      handOff.capability.mockReturnValueOnce(expired.promise).mockReturnValueOnce(current.promise)
      handOff.options.mockResolvedValue({ status: 'current' })
      render(<StructuredChatTab inWorkspace fallback={fallback} />)
      await act(async () => {
        openMenuHandOff()
        openMenuHandOff()
      })
      expect(handOff.capability).toHaveBeenCalledOnce()
      await act(async () => vi.advanceTimersByTimeAsync(30_000))
      if (fallback) {
        expect(handOff.dialog.mock.lastCall?.[0].request.source.capturedText).toContain(
          'Keep the task context'
        )
        expect(handOff.dialog.mock.lastCall?.[0].request.source.capturedText).toContain(
          'Keep the answer'
        )
        expect(handOff.dialog.mock.lastCall?.[0].request.source.capturedText).not.toContain(
          'worker assignment'
        )
        fireEvent.click(screen.getByText('Close hand-off'))
      } else {
        expect(handOff.error).toHaveBeenCalledOnce()
        expect(screen.queryByText('Close hand-off')).toBeNull()
      }
      await act(async () => openMenuHandOff())
      await act(async () => expired.resolve(true))
      expect(handOff.options).not.toHaveBeenCalled()
      await act(async () => current.resolve(true))
      expect(handOff.options).toHaveBeenCalledOnce()
    }
  )
})
