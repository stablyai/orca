// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import DashboardAgentRow from '@/components/dashboard/DashboardAgentRow'
import { CompactAgentRow } from '@/components/sidebar/worktree-card-compact-agent-row'
import {
  shouldIgnoreNestedWorktreeContextMenuScope,
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR
} from '@/components/sidebar/worktree-context-menu-policy'
import { VaultSessionRow } from '@/components/right-sidebar/AiVaultSessionRow'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  conversationReferenceToken,
  conversationReferenceUri,
  type ConversationReference
} from '../../../../shared/conversation-reference'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from './native-chat-composer-draft-storage'
import { promptValue } from './native-chat-prompt-editor.test-support'
import { ConversationReferenceChatPane } from './conversation-reference-chat-pane.test-support'

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('./NativeChatComposerActions', () => ({
  NativeChatComposerActions: ({
    onSend,
    sendDisabled
  }: {
    onSend: () => void
    sendDisabled: boolean
  }) => (
    <button type="button" data-testid="send" disabled={sendDisabled} onClick={onSend}>
      Send
    </button>
  )
}))
vi.mock('./NativeChatAutocompleteMenus', () => ({
  NativeChatMentionMenu: () => null,
  NativeChatPickerMenu: () => null
}))
vi.mock('@/components/dashboard/use-agent-row-conversation-name', () => ({
  useAgentRowConversationName: () => null
}))
vi.mock('@/components/sidebar/CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownForPane: () => null
}))

const reference: ConversationReference = {
  uri: conversationReferenceUri('12345678-1234-4234-8234-123456789abc'),
  title: 'Earlier conversation',
  agent: 'claude'
}
const token = conversationReferenceToken(reference)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let create: ReturnType<typeof vi.fn>
let writeClipboard: ReturnType<typeof vi.fn>
const sent = vi.fn()
let draftStorage: ReturnType<typeof createMemoryNativeChatComposerDraftStorage>

function ChatPane(props: Parameters<typeof ConversationReferenceChatPane>[0]): React.JSX.Element {
  return <ConversationReferenceChatPane onSend={sent} {...props} />
}

beforeEach(() => {
  draftStorage = createMemoryNativeChatComposerDraftStorage()
  setNativeChatComposerDraftStorageForTests(draftStorage)
  create = vi.fn(async () => reference)
  writeClipboard = vi.fn(async () => undefined)
  vi.stubGlobal('api', {
    aiVault: {
      createConversationReference: create,
      getFirstUserPrompt: vi.fn().mockResolvedValue({ prompt: null }),
      listSubagentSessions: vi.fn().mockResolvedValue({ sessions: [] })
    },
    ui: { writeTerminalClipboardText: writeClipboard }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  clearNativeChatDraftCacheForTests()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

/** The workspace card's capture handler, using the sidebar's own nested-scope policy. */
function WorkspaceScope({
  children,
  onMenu,
  onClick
}: {
  children: ReactNode
  onMenu: () => void
  onClick: () => void
}): React.JSX.Element {
  return (
    <div
      {...{ [WORKTREE_CONTEXT_MENU_SCOPE_ATTR]: 'worktree' }}
      onContextMenuCapture={(event) => {
        if (shouldIgnoreNestedWorktreeContextMenuScope(event.currentTarget, event.target)) {
          return
        }
        event.preventDefault()
        onMenu()
      }}
      onClick={onClick}
    >
      {children}
    </div>
  )
}

function agentRow(overrides: Partial<DashboardAgentRowData['entry']> = {}): DashboardAgentRowData {
  return {
    paneKey: 'tab-1:leaf-1',
    tab: {
      id: 'tab-1',
      worktreeId: 'wt-1',
      ptyId: null,
      title: 'Claude',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    },
    agentType: 'claude',
    state: 'done',
    startedAt: 500,
    entry: {
      prompt: 'Earlier conversation',
      state: 'done',
      stateStartedAt: 1000,
      paneKey: 'tab-1:leaf-1',
      updatedAt: 1000,
      stateHistory: [],
      providerSession: { key: 'session_id', id: 'claude-session-1' },
      ...overrides
    }
  }
}

const historySession: AiVaultSession = {
  id: 'local:claude:hist-1:/home/a/.claude/hist-1.jsonl',
  executionHostId: 'local',
  agent: 'claude',
  sessionId: 'hist-1',
  title: 'History conversation',
  cwd: null,
  branch: null,
  model: null,
  filePath: '/home/a/.claude/hist-1.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-10-24T00:00:00Z',
  messageCount: 2,
  totalTokens: 0,
  previewMessages: [{ role: 'assistant', text: 'Ready when you are', timestamp: null }],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: 'claude --resume hist-1',
  subagent: null
}

function HistoryRow(): React.JSX.Element {
  return (
    <VaultSessionRow
      session={historySession}
      liveState={null}
      resumeStartup={{ command: 'claude --resume hist-1' }}
      realHomeResumeStartup={{ command: 'claude --resume hist-1' }}
      worktreeInfo={null}
      vaultScope="all"
      detailsExpanded={false}
      resumeDisabled={false}
      onToggleDetails={() => {}}
      showJumpToWorktree={false}
      onResume={() => {}}
      resumeLabel="Resume"
      resumeActions={{
        worktree: { worktreeId: null, disabled: true },
        newTab: { worktreeId: null, disabled: true }
      }}
      onResumeInWorktree={() => {}}
      onResumeInNewTab={() => {}}
      onCopyId={() => {}}
    />
  )
}

function editorIn(paneId: string): HTMLElement {
  return within(screen.getByTestId(`chat-${paneId}`)).getByRole('textbox')
}

function pillIn(paneId: string): Element | null {
  return screen
    .getByTestId(`chat-${paneId}`)
    .querySelector('[data-native-chat-conversation-reference]')
}

async function chooseReference(target: HTMLElement): Promise<void> {
  fireEvent.contextMenu(target)
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Reference conversation' }))
}

const rowKinds = [
  [
    'compact sidebar row',
    (agent: DashboardAgentRowData, onActivate: () => void) => (
      <CompactAgentRow agent={agent} now={2000} onActivate={onActivate} />
    )
  ],
  [
    'dashboard row',
    (agent: DashboardAgentRowData, onActivate: () => void) => (
      <DashboardAgentRow agent={agent} now={2000} onActivate={onActivate} onDismiss={() => {}} />
    )
  ]
] as const

describe.each(rowKinds)('Reference conversation on a %s', (_kind, renderAgentRow) => {
  it('opens its own menu inside the workspace card and adds a pill to the focused chat', async () => {
    const parentMenu = vi.fn()
    const parentClick = vi.fn()
    const activate = vi.fn()
    writeNativeChatDraftCache('a', 'Keep this draft')
    render(
      <TooltipProvider>
        <ChatPane id="a" visible focused />
        <WorkspaceScope onMenu={parentMenu} onClick={parentClick}>
          {renderAgentRow(agentRow(), activate)}
        </WorkspaceScope>
      </TooltipProvider>
    )

    await chooseReference(screen.getByText('Earlier conversation'))

    expect(parentMenu).not.toHaveBeenCalled()
    expect(parentClick).not.toHaveBeenCalled()
    expect(activate).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledWith({
      source: { kind: 'transcript', agent: 'claude', sessionId: 'claude-session-1' },
      title: 'Earlier conversation',
      executionHostId: 'local'
    })
    await waitFor(() => expect(pillIn('a')?.textContent).toBe(reference.title))
    expect(promptValue(editorIn('a'))).toContain('Keep this draft')
    expect(promptValue(editorIn('a'))).toContain(token)
    expect(sent).not.toHaveBeenCalled()
    expect(writeClipboard).not.toHaveBeenCalled()
  })

  it('leaves a row without a conversation to the workspace menu', () => {
    const parentMenu = vi.fn()
    render(
      <TooltipProvider>
        <ChatPane id="a" visible focused />
        <WorkspaceScope onMenu={parentMenu} onClick={() => {}}>
          {renderAgentRow(agentRow({ providerSession: undefined }), () => {})}
        </WorkspaceScope>
      </TooltipProvider>
    )

    fireEvent.contextMenu(screen.getByText('Earlier conversation'))

    expect(parentMenu).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menuitem', { name: 'Reference conversation' })).toBeNull()
  })
})
describe('Reference conversation in session history menus', () => {
  it('offers Reference and Copy in both the context and overflow menus', async () => {
    writeNativeChatDraftCache('a', 'Keep this draft')
    render(
      <TooltipProvider>
        <ChatPane id="a" visible focused />
        <HistoryRow />
      </TooltipProvider>
    )
    const source = {
      source: {
        kind: 'transcript',
        agent: 'claude',
        sessionId: 'hist-1',
        filePath: '/home/a/.claude/hist-1.jsonl',
        codexHome: null
      },
      title: 'History conversation',
      executionHostId: 'local'
    }

    fireEvent.contextMenu(screen.getByText('History conversation'))
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Copy conversation reference' })
    )
    await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith(token))
    expect(readNativeChatDraftCache('a')).toBe('Keep this draft')

    await userEvent.click(screen.getByTestId('ai-vault-session-more-actions'))
    expect(
      await screen.findByRole('menuitem', { name: 'Copy conversation reference' })
    ).toBeTruthy()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Reference conversation' }))
    await waitFor(() => expect(pillIn('a')).not.toBeNull())
    expect(create).toHaveBeenLastCalledWith(source)
    expect(promptValue(editorIn('a'))).toContain('Keep this draft')

    await chooseReference(screen.getByText('History conversation'))
    await waitFor(() =>
      expect(
        screen.getByTestId('chat-a').querySelectorAll('[data-native-chat-conversation-reference]')
      ).toHaveLength(2)
    )
    expect(sent).not.toHaveBeenCalled()
  })
})

describe('Reference conversation targets', () => {
  it('refuses clearly when no chat is revealed, without a clipboard fallback', async () => {
    render(
      <TooltipProvider>
        <ChatPane id="a" visible={false} focused={false} />
        <HistoryRow />
      </TooltipProvider>
    )

    await chooseReference(screen.getByText('History conversation'))

    expect(toast.error).toHaveBeenCalledWith(
      'Open a chat to reference this conversation in its message box.'
    )
    expect(create).not.toHaveBeenCalled()
    expect(writeClipboard).not.toHaveBeenCalled()
    expect(readNativeChatDraftCache('a')).toBe('')
  })

  it('goes to the chat in the focused group, not a visible unfocused one', async () => {
    render(
      <TooltipProvider>
        <ChatPane id="a" visible focused={false} />
        <ChatPane id="b" visible focused />
        <HistoryRow />
      </TooltipProvider>
    )

    await chooseReference(screen.getByText('History conversation'))

    await waitFor(() => expect(pillIn('b')).not.toBeNull())
    expect(pillIn('a')).toBeNull()
    expect(readNativeChatDraftCache('a')).toBe('')
  })

  it('refuses two revealed chats until one was focused', async () => {
    render(
      <TooltipProvider>
        <ChatPane id="a" visible focused />
        <ChatPane id="b" visible focused />
        <HistoryRow />
      </TooltipProvider>
    )

    await chooseReference(screen.getByText('History conversation'))
    expect(toast.error).toHaveBeenCalledWith(
      'Click the message box of the chat to reference this conversation in, then try again.'
    )
    expect(create).not.toHaveBeenCalled()

    act(() => editorIn('b').focus())
    await chooseReference(screen.getByText('History conversation'))
    await waitFor(() => expect(pillIn('b')).not.toBeNull())
    expect(pillIn('a')).toBeNull()
  })

  it('refuses a disabled or mid-composition chat before creating anything', async () => {
    const view = render(
      <TooltipProvider>
        <ChatPane id="a" visible focused disabled />
        <HistoryRow />
      </TooltipProvider>
    )
    await chooseReference(screen.getByText('History conversation'))
    expect(toast.error).toHaveBeenLastCalledWith('The open chat cannot take a message right now.')

    view.rerender(
      <TooltipProvider>
        <ChatPane id="a" visible focused />
        <HistoryRow />
      </TooltipProvider>
    )
    fireEvent.compositionStart(editorIn('a'))
    await chooseReference(screen.getByText('History conversation'))
    expect(toast.error).toHaveBeenCalledTimes(2)
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses a source host the target chat cannot reach', async () => {
    render(
      <TooltipProvider>
        <ChatPane id="a" visible focused environmentId="env-1" />
        <HistoryRow />
      </TooltipProvider>
    )

    await chooseReference(screen.getByText('History conversation'))

    expect(toast.error).toHaveBeenCalledWith(
      'This agent cannot reach the conversation on its source host. Open the chat on that host to reference it.'
    )
    expect(create).not.toHaveBeenCalled()
  })

  it('reports a refused create and leaves the draft and send as they were', async () => {
    create.mockRejectedValueOnce(new Error('The source conversation belongs to another host.'))
    writeNativeChatDraftCache('a', 'Keep this draft')
    render(
      <TooltipProvider>
        <ChatPane id="a" visible focused />
        <HistoryRow />
      </TooltipProvider>
    )

    await chooseReference(screen.getByText('History conversation'))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('The source conversation belongs to another host.')
    )
    expect(readNativeChatDraftCache('a')).toBe('Keep this draft')
    expect(pillIn('a')).toBeNull()
    expect(screen.getByTestId('send').hasAttribute('disabled')).toBe(false)
  })
})

describe('Reference conversation answered late', () => {
  function Panes({ active }: { active: 'a' | 'b' }): React.JSX.Element {
    return (
      <TooltipProvider>
        <ChatPane id="a" visible={active === 'a'} focused={active === 'a'} />
        <ChatPane id="b" visible={active === 'b'} focused={active === 'b'} />
        <HistoryRow />
      </TooltipProvider>
    )
  }

  function sendIn(paneId: string): HTMLElement {
    return within(screen.getByTestId(`chat-${paneId}`)).getByTestId('send')
  }

  it('keeps focus in the newly focused split while appending to the original visible chat', async () => {
    const answer = deferred<ConversationReference>()
    create.mockReturnValueOnce(answer.promise)
    writeNativeChatDraftCache('a', 'Original draft')
    writeNativeChatDraftCache('b', 'Other draft')
    function Splits({ active }: { active: 'a' | 'b' }): React.JSX.Element {
      return (
        <TooltipProvider>
          <ChatPane id="a" visible focused={active === 'a'} />
          <ChatPane id="b" visible focused={active === 'b'} />
          <HistoryRow />
        </TooltipProvider>
      )
    }
    const view = render(<Splits active="a" />)
    await chooseReference(screen.getByText('History conversation'))
    view.rerender(<Splits active="b" />)
    act(() => editorIn('b').focus())

    await act(async () => answer.resolve(reference))

    expect(document.activeElement).toBe(editorIn('b'))
    expect(readNativeChatDraftCache('a')).toContain('Original draft')
    expect(readNativeChatDraftCache('a')).toContain(token)
    expect(readNativeChatDraftCache('b')).toBe('Other draft')
    expect(pillIn('b')).toBeNull()
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(sent).not.toHaveBeenCalled()
  })

  it('reports a refused draft save without claiming the reference was saved', async () => {
    const answer = deferred<ConversationReference>()
    create.mockReturnValueOnce(answer.promise)
    writeNativeChatDraftCache('a', 'Original draft')
    writeNativeChatDraftCache('b', 'Other draft')
    const view = render(<Panes active="a" />)
    await chooseReference(screen.getByText('History conversation'))
    view.rerender(<Panes active="b" />)
    draftStorage.refuseWrites = true

    await act(async () => answer.resolve(reference))

    expect(toast.error).toHaveBeenCalledWith(
      'The conversation reference could not be saved to the target draft.'
    )
    expect(toast.success).not.toHaveBeenCalled()
    expect(readNativeChatDraftCache('a')).toContain('Original draft')
    expect(readNativeChatDraftCache('a')).toContain(token)
    expect(readNativeChatDraftCache('b')).toBe('Other draft')
    expect(pillIn('b')).toBeNull()
    expect(sendIn('b').hasAttribute('disabled')).toBe(false)
    expect(sent).not.toHaveBeenCalled()
  })

  it('lands in the captured chat after a switch away and back, never the newly shown one', async () => {
    const answer = deferred<ConversationReference>()
    create.mockReturnValueOnce(answer.promise)
    writeNativeChatDraftCache('a', 'Keep this draft')
    writeNativeChatDraftCache('b', 'Other draft')
    const view = render(<Panes active="a" />)

    await chooseReference(screen.getByText('History conversation'))
    expect(sendIn('a').hasAttribute('disabled')).toBe(true)
    view.rerender(<Panes active="b" />)
    expect(sendIn('b').hasAttribute('disabled')).toBe(false)
    await act(async () => answer.resolve(reference))

    expect(readNativeChatDraftCache('b')).toBe('Other draft')
    expect(pillIn('b')).toBeNull()
    expect(readNativeChatDraftCache('a')).toContain('Keep this draft')
    expect(readNativeChatDraftCache('a')).toContain(token)
    expect(toast.success).toHaveBeenCalledWith(
      'The conversation reference was added to the draft of the chat it was meant for.'
    )

    view.rerender(<Panes active="a" />)
    expect(pillIn('a')?.textContent).toBe(reference.title)
    expect(promptValue(editorIn('a'))).toContain('Keep this draft')
    expect(sendIn('a').hasAttribute('disabled')).toBe(false)
    expect(sent).not.toHaveBeenCalled()
  })

  it('holds the token through a composition that started while it was created', async () => {
    const answer = deferred<ConversationReference>()
    create.mockReturnValueOnce(answer.promise)
    writeNativeChatDraftCache('a', 'Keep this draft')
    render(<Panes active="a" />)

    await chooseReference(screen.getByText('History conversation'))
    const editor = editorIn('a')
    fireEvent.compositionStart(editor)
    await act(async () => answer.resolve(reference))

    expect(pillIn('a')).toBeNull()
    fireEvent.compositionEnd(editor, { data: '' })
    expect(readNativeChatDraftCache('a')).toContain('Keep this draft')
    expect(readNativeChatDraftCache('a')).toContain(token)
    await waitFor(() => expect(pillIn('a')).not.toBeNull())
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('does not type into a chat that became disabled while it was created', async () => {
    const answer = deferred<ConversationReference>()
    create.mockReturnValueOnce(answer.promise)
    writeNativeChatDraftCache('a', 'Keep this draft')
    const view = render(
      <TooltipProvider>
        <ChatPane id="a" visible focused />
        <HistoryRow />
      </TooltipProvider>
    )

    await chooseReference(screen.getByText('History conversation'))
    view.rerender(
      <TooltipProvider>
        <ChatPane id="a" visible focused disabled />
        <HistoryRow />
      </TooltipProvider>
    )
    await act(async () => answer.resolve(reference))

    expect(editorIn('a').contains(document.activeElement)).toBe(false)
    expect(readNativeChatDraftCache('a')).toContain('Keep this draft')
    expect(readNativeChatDraftCache('a')).toContain(token)
  })
})
