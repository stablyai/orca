// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import type { RefObject } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatPickerItem } from '../../../../shared/native-chat/input/native-chat-picker-items'
import type { QueuedMessageInlineEditor } from './use-structured-agent-session-queued-edit'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

type CommandItem = Extract<NativeChatPickerItem, { kind: 'command' }>

type FieldProps = {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  autocomplete?: { mode: string; items?: NativeChatPickerItem[] }
  onChooseMentionFile?: (path: string) => void
  onSend?: () => void
  onChoosePickerItem?: (item: NativeChatPickerItem) => void
}
type KeyDownArgs = {
  completePickerItem: (item: NativeChatPickerItem) => void
  dispatchPickerCommand: (item: CommandItem) => void
}

const mocks = vi.hoisted(() => {
  const captured: {
    draft: string
    imageAttachments: { id: string; path: string }[]
    fieldProps: FieldProps | null
    keyDownArgs: KeyDownArgs | null
  } = { draft: '/resume', imageAttachments: [], fieldProps: null, keyDownArgs: null }
  const fns = { setDraft: vi.fn(), clearImageAttachments: vi.fn(), openHistory: vi.fn() }
  return Object.assign(captured, fns, { sendNativeChatTypedCommand: vi.fn() })
})

vi.mock('../../store', () => {
  const state = {
    dictationState: 'idle',
    settings: { voice: { enabled: false }, nativeChatSessionOptions: {} },
    agentStatusByPaneKey: {},
    activeWorktreeId: 'wt-1',
    activeWorkspaceExecutionHostId: 'ssh:box',
    tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
    unifiedTabsByWorktree: {},
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    clearNativeChatLaunchDraft: vi.fn()
  }
  const useAppStore = (selector: (value: typeof state) => unknown) => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})
vi.mock('../right-sidebar/ai-vault-panel-workspace', () => ({
  selectAiVaultPanelWorkspace: () => ({ worktree: { id: 'wt-1' }, repo: null })
}))
vi.mock('../right-sidebar/agent-session-history-modal', () => ({
  openAgentSessionHistoryModal: mocks.openHistory
}))
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: vi.fn(),
  sendNativeChatTypedCommand: mocks.sendNativeChatTypedCommand
}))
vi.mock('./use-native-chat-draft', () => ({
  useNativeChatDraft: () => ({ draft: mocks.draft, setDraft: mocks.setDraft })
}))
vi.mock('./NativeChatComposerField', () => ({
  NativeChatComposerField: (props: FieldProps) => {
    mocks.fieldProps = props
    // Holds the draft as the real editor does; a picker completes the text the editor holds.
    return <textarea ref={props.textareaRef} value={mocks.draft} readOnly />
  }
}))
vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))
vi.mock('./use-native-chat-composer-attachments', () => ({
  useNativeChatComposerAttachments: () => ({
    imageAttachments: mocks.imageAttachments,
    clearImageAttachments: mocks.clearImageAttachments,
    pendingChips: {}
  })
}))
vi.mock('./use-native-chat-composer-keydown', () => ({
  useNativeChatComposerKeyDown: (args: KeyDownArgs) => {
    mocks.keyDownArgs = args
    return vi.fn()
  }
}))

import {
  createNativeChatQueuedEditDraft,
  discardNativeChatQueuedEdit
} from './native-chat-queued-edit-draft'
import { NativeChatComposer } from './NativeChatComposer'

const RESUME: CommandItem = {
  kind: 'command',
  id: 'command:resume',
  name: 'resume',
  token: '/resume',
  skillCollision: false,
  orcaOwned: true
}

function renderStructuredChat(editSession?: QueuedMessageInlineEditor) {
  const transport: NativeChatStructuredComposerTransport = {
    capturePresentation: () => () => true,
    ...(editSession ? { threadGoal: { setObjective: vi.fn(async () => true) } } : {}),
    send: vi.fn(() => true),
    dispatchCommand: vi.fn(async () => ({ handled: false, accepted: false, error: null })),
    optionsSurface: {
      getSnapshot: () => [],
      setOption: vi.fn(),
      invokeAction: vi.fn(),
      subscribe: () => () => {}
    },
    optionSnapshot: [],
    onError: vi.fn(),
    runtime: 'local',
    sessionId: 'session-test',
    worktreeId: 'wt-structured',
    runtimeEnvironmentId: null
  }
  const chat = () => (
    <NativeChatComposer
      terminalTabId="tab-1"
      editSession={editSession}
      draftScopeKey={editSession?.draftScopeKey}
      paneKey="tab-1:structured"
      targetPtyId={null}
      agent="claude"
      structuredTransport={transport}
    />
  )
  const view = render(chat())
  return { transport, rerender: () => view.rerender(chat()) }
}

describe('/resume in the native chat composer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.draft = '/resume'
    mocks.imageAttachments = []
    mocks.fieldProps = null
    mocks.keyDownArgs = null
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { git: { discoverCommitMessageModels: vi.fn(async () => ({ success: false })) } }
    })
  })
  afterEach(() => cleanup())

  it("opens a structured chat's history, typed in any case, and sends nothing", () => {
    mocks.draft = '/Resume  auth  retry'
    mocks.imageAttachments = [{ id: 'img-1', path: '/tmp/a.png' }]
    const { transport } = renderStructuredChat()
    let focusedAtOpen: Element | null = null
    mocks.openHistory.mockImplementation(() => (focusedAtOpen = document.activeElement))

    // Clicking Send leaves focus on the button; the dialog must be able to hand it back to the chat.
    act(() => mocks.fieldProps?.onSend?.())
    expect(focusedAtOpen).toBeInstanceOf(HTMLTextAreaElement)

    expect(mocks.openHistory).toHaveBeenCalledWith({
      workspace: { worktreeId: 'wt-structured' },
      chatTabId: 'tab-1',
      initialQuery: 'auth retry',
      agent: 'claude'
    })
    expect(transport.send).not.toHaveBeenCalled()
    expect(transport.dispatchCommand).not.toHaveBeenCalled()
    expect(mocks.setDraft).toHaveBeenCalledWith('')
    expect(mocks.clearImageAttachments).not.toHaveBeenCalled()

    cleanup()
    mocks.draft = '/res'
    renderStructuredChat()
    act(() => mocks.keyDownArgs?.dispatchPickerCommand(RESUME))
    expect(mocks.openHistory).toHaveBeenCalledTimes(2)
  })

  it('sends a picked skill named resume to the agent, as the skill it is', () => {
    mocks.draft = '/res'
    const { transport, rerender } = renderStructuredChat()
    act(() =>
      mocks.fieldProps?.onChoosePickerItem?.({
        kind: 'skill',
        id: 'skill:resume',
        name: 'resume',
        token: '/resume',
        description: null,
        sources: []
      })
    )
    mocks.draft = '/resume make it one page'
    rerender()

    act(() => mocks.fieldProps?.onSend?.())

    expect(mocks.openHistory).not.toHaveBeenCalled()
    expect(transport.dispatchCommand).toHaveBeenCalledWith('/resume make it one page')
    mocks.draft = '/resume'
    rerender()
    act(() => mocks.keyDownArgs?.dispatchPickerCommand(RESUME))
    expect(mocks.openHistory).toHaveBeenCalledOnce()
  })

  it('reopened native slash identity permits only edit Save and cannot authorize a stale command row', () => {
    const draft = createNativeChatQueuedEditDraft(
      {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: '/model\nintent' }],
        skills: [{ name: 'model', path: '/selected/SKILL.md' }]
      },
      'bottom'
    )
    mocks.draft = '/model\nintent'
    const editor: QueuedMessageInlineEditor = {
      messageId: 'seeded',
      draftScopeKey: draft.scopeKey,
      text: mocks.draft,
      change: vi.fn(),
      acquiring: false,
      saving: false,
      canSave: true,
      imagesCapable: true,
      save: vi.fn(),
      cancel: vi.fn()
    }
    const { transport } = renderStructuredChat(editor)
    act(() => mocks.fieldProps?.onSend?.())
    expect(editor.save).toHaveBeenCalledOnce()
    act(() =>
      mocks.fieldProps?.onChoosePickerItem?.({
        ...RESUME,
        id: 'command:model',
        name: 'model',
        token: '/model'
      })
    )
    expect(editor.save).toHaveBeenCalledOnce()
    expect(transport.dispatchCommand).not.toHaveBeenCalled()
    expect(transport.send).not.toHaveBeenCalled()
    discardNativeChatQueuedEdit(draft)
  })

  it.each(['/compact', '/goal ship it', '/resume old chat'])(
    'saves literal %s but refuses its picked control without dispatch',
    (text) => {
      mocks.draft = text
      const editor: QueuedMessageInlineEditor = {
        messageId: 'queued',
        draftScopeKey: 'queued-edit:test',
        text,
        change: vi.fn(),
        acquiring: false,
        saving: false,
        canSave: true,
        imagesCapable: true,
        save: vi.fn(),
        cancel: vi.fn()
      }
      const { transport } = renderStructuredChat(editor)
      act(() => mocks.fieldProps?.onSend?.())
      const name = text.slice(1).split(' ')[0]!
      const item: CommandItem = { ...RESUME, id: `command:${name}`, name, token: `/${name}` }
      act(() => mocks.keyDownArgs?.dispatchPickerCommand(item))
      act(() => mocks.fieldProps?.onChoosePickerItem?.(item))
      expect(editor.save).toHaveBeenCalledOnce()
      expect(transport.send).not.toHaveBeenCalled()
      expect(transport.threadGoal?.setObjective).not.toHaveBeenCalled()
      expect(transport.dispatchCommand).not.toHaveBeenCalled()
      expect(mocks.sendNativeChatTypedCommand).not.toHaveBeenCalled()
      expect(mocks.openHistory).not.toHaveBeenCalled()
      expect(mocks.setDraft).not.toHaveBeenCalledWith('')
    }
  )

  it('saves ordinary text and a picked provider skill without any send or command RPC', () => {
    mocks.draft = '/res'
    const editor: QueuedMessageInlineEditor = {
      messageId: 'queued',
      draftScopeKey: 'queued-edit:test',
      text: '/res',
      change: vi.fn(),
      acquiring: false,
      saving: false,
      canSave: true,
      imagesCapable: true,
      save: vi.fn(),
      cancel: vi.fn()
    }
    const { transport, rerender } = renderStructuredChat(editor)
    act(() =>
      mocks.fieldProps?.onChoosePickerItem?.({
        kind: 'skill',
        id: 'skill:resume',
        name: 'resume',
        token: '/resume',
        description: null,
        sources: []
      })
    )
    mocks.draft = '/resume write a page'
    rerender()
    act(() => mocks.fieldProps?.onSend?.())
    expect(editor.save).toHaveBeenCalledOnce()
    expect(transport.send).not.toHaveBeenCalled()
    expect(transport.dispatchCommand).not.toHaveBeenCalled()
    expect(mocks.openHistory).not.toHaveBeenCalled()
  })

  // A terminal-backed chat (every SSH chat, for one) keeps the agent's own /resume.
  it('leaves /resume to the agent in a terminal-backed chat', () => {
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId="pty-1"
        agent="codex"
      />
    )

    act(() => mocks.fieldProps?.onSend?.())

    expect(mocks.openHistory).not.toHaveBeenCalled()
    expect(mocks.sendNativeChatTypedCommand).toHaveBeenCalledWith('pty-1', '/resume')
  })

  it('derives inline catalog from the same action boundary before resolving namesake skills', () => {
    mocks.draft = '/'
    const edit: QueuedMessageInlineEditor = {
      messageId: 'queue',
      draftScopeKey: 'queued-edit:menu',
      text: '/',
      acquiring: false,
      saving: false,
      canSave: true,
      imagesCapable: true,
      save: vi.fn(),
      cancel: vi.fn(),
      change: vi.fn()
    }
    const { transport, rerender } = renderStructuredChat(edit)
    transport.sessionCommands = [
      { name: 'review', kind: 'command' },
      { name: 'model', kind: 'skill', path: '/model/SKILL.md' },
      { name: 'goal', kind: 'command' }
    ]
    transport.conversationCommands = ['clear', 'compact']
    rerender()
    expect(
      mocks.fieldProps?.autocomplete?.items?.map(({ kind, name }) => `${kind}:${name}`)
    ).toEqual(['command:review', 'skill:model'])
    expect(mocks.openHistory).not.toHaveBeenCalled()
    // Without a host goal action /goal is valid provider prompt input.
    delete transport.threadGoal
    rerender()
    expect(mocks.fieldProps?.autocomplete?.items?.map(({ name }) => name)).toContain('goal')
    mocks.draft = '/goal objective'
    rerender()
    act(() => mocks.fieldProps?.onSend?.())
    expect(edit.save).toHaveBeenCalledOnce()
    expect(transport.send).not.toHaveBeenCalled()
    expect(transport.dispatchCommand).not.toHaveBeenCalled()
    mocks.draft = '@src'
    rerender()
    expect(mocks.fieldProps?.autocomplete?.mode).toBe('mention')
    act(() => mocks.fieldProps?.onChooseMentionFile?.('src/file.ts'))
    expect(mocks.setDraft).toHaveBeenCalledWith(expect.stringContaining('src/file.ts'))
  })
})
