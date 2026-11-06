// @vitest-environment happy-dom

// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useLayoutEffect, type RefObject } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStructuredAgentSessionOptionsWriteOwner } from '../../../../shared/agent-session/options/structured-agent-session-options-write-owner'
import { createStructuredSessionSelectionController } from '../../../../shared/agent-session/options/structured-agent-session-selection-operations'
import { createStructuredAgentSessionOptionState } from '../../../../shared/agent-session/options/structured-agent-session-options'
import { structuredAgentSessionSeedCatalog } from '../../../../shared/agent-session/options/structured-agent-session-seed-catalog'
import type { NativeChatPickerItem } from '../../../../shared/native-chat/input/native-chat-picker-items'
import type { QueuedMessageInlineEditor } from './use-structured-agent-session-queued-edit'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat/input/native-chat-session-options'
import { dispatchStructuredAgentSessionComposerCommand } from '../../../../shared/agent-session/view/structured-agent-session-composer'

type CommandItem = Extract<NativeChatPickerItem, { kind: 'command' }>

type FieldProps = {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  autocomplete?: { mode: string; items?: NativeChatPickerItem[] }
  onChooseMentionFile?: (path: string) => void
  onSend?: () => void
  sendButtonDisabled?: boolean
  onChoosePickerItem?: (item: NativeChatPickerItem) => void
  goalMode?: { active: boolean }
}
type KeyDownArgs = {
  send: () => void
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

vi.mock('./NativeChatComposerWorkspace', () => ({ NativeChatComposerWorkspace: () => null }))

vi.mock('../../store/index', () => {
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
vi.mock('../right-sidebar/ai-vault/scope/ai-vault-panel-workspace', () => ({
  selectAiVaultPanelWorkspace: () => ({ worktree: { id: 'wt-1' }, repo: null })
}))
vi.mock('../right-sidebar/ai-vault/panel/agent-session-history-modal', () => ({
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
    const draft = mocks.draft
    useLayoutEffect(() => {
      if (props.textareaRef.current) {
        props.textareaRef.current.value = draft
      }
    }, [draft, props.textareaRef])
    // Holds the draft as the real editor does; a picker completes the text the editor holds.
    return (
      <>
        <textarea ref={props.textareaRef} defaultValue={mocks.draft} />
        <button disabled={props.sendButtonDisabled} onClick={props.onSend}>
          Send command
        </button>
      </>
    )
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

import { NativeChatComposer } from './NativeChatComposer'

function renderStructuredChat(
  editSession?: QueuedMessageInlineEditor,
  agent: AgentType = 'claude'
) {
  const transport: NativeChatStructuredComposerTransport = {
    capturePresentation: () => () => true,
    ...(editSession ? { threadGoal: { setObjective: vi.fn(async () => true) } } : {}),
    send: vi.fn(() => true),
    dispatchCommand: vi.fn(async () => ({ handled: false, accepted: false, error: null })),
    optionsSurface: {
      admits: vi.fn(() => true),
      getSnapshot: () => [],
      setOption: vi.fn(async () => ({ snapshot: [] })),
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
      agent={agent}
      structuredTransport={transport}
    />
  )
  const view = render(chat())
  return { transport, rerender: () => view.rerender(chat()) }
}

const USAGE: CommandItem = {
  kind: 'command',
  id: 'command:usage',
  name: 'usage',
  token: '/usage',
  skillCollision: false,
  orcaOwned: true
}

const MODE: SessionOptionDescriptor = {
  id: 'interactionMode',
  label: 'Mode',
  category: 'mode',
  kind: {
    type: 'select',
    currentValue: 'default',
    choices: [
      { value: 'default', label: 'Build' },
      { value: 'plan', label: 'Plan' }
    ]
  },
  valueSource: 'default',
  transport: 'agent-session',
  settable: true
}

describe('structured composer control picks', () => {
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

  it.each([
    ['claude', '/plan', 'plan'],
    ['codex', '/default', 'default']
  ] as const)(
    'lets %s %s configure a held host through Send and Enter',
    async (agent, draft, mode) => {
      mocks.draft = draft
      const { transport, rerender } = renderStructuredChat(undefined, agent)
      transport.sendBlockedReason = 'The host is waiting'
      vi.mocked(transport.dispatchCommand).mockImplementation((text) =>
        dispatchStructuredAgentSessionComposerCommand(text, {
          agent,
          snapshot: transport.optionSnapshot,
          setOption: async (id, value) => {
            await transport.optionsSurface.setOption(id, value)
            return true
          },
          invokeAction: async () => false
        })
      )
      rerender()
      expect(screen.getByRole('button', { name: 'Send command' }).hasAttribute('disabled')).toBe(
        true
      )
      transport.optionSnapshot = [MODE]
      rerender()
      const button = screen.getByRole('button', { name: 'Send command' })
      expect(button.hasAttribute('disabled')).toBe(false)
      await act(async () => fireEvent.click(button))
      expect(transport.optionsSurface.setOption).toHaveBeenLastCalledWith('interactionMode', mode)
      await act(async () => mocks.keyDownArgs?.send())
      expect(transport.optionsSurface.setOption).toHaveBeenCalledTimes(2)
      expect(transport.dispatchCommand).toHaveBeenNthCalledWith(1, draft)
      expect(transport.dispatchCommand).toHaveBeenNthCalledWith(2, draft)
      transport.sendOut = true
      rerender()
      expect(button.hasAttribute('disabled')).toBe(true)
      await act(async () => fireEvent.click(button))
      expect(transport.optionsSurface.setOption).toHaveBeenCalledTimes(2)
      expect(transport.send).not.toHaveBeenCalled()
    }
  )

  it.each(['claude', 'codex'] as const)(
    'applies %s mode picks through every picker route without sending or losing draft text',
    async (agent) => {
      mocks.draft = '/pl'
      mocks.imageAttachments = [{ id: 'kept-image', path: '/tmp/kept.png' }]
      const { transport, rerender } = renderStructuredChat(undefined, agent)
      transport.optionSnapshot = [MODE]
      transport.sessionCommands = [
        { name: 'plan', kind: 'command', description: 'Toggle plan mode' },
        { name: 'plan', kind: 'command', description: 'Switch to Plan mode' }
      ]
      rerender()
      const plans = mocks.fieldProps?.autocomplete?.items?.filter(
        (item): item is CommandItem => item.kind === 'command' && item.name === 'plan'
      )
      expect(plans).toHaveLength(1)
      const plan = plans![0]!
      const input = document.querySelector('textarea')!
      const reply = Promise.withResolvers<{ snapshot: SessionOptionDescriptor[] }>()
      vi.mocked(transport.optionsSurface.setOption).mockReturnValue(reply.promise)
      const choose = [
        () => mocks.fieldProps?.onChoosePickerItem?.(plan),
        () => mocks.keyDownArgs?.completePickerItem(plan),
        () => mocks.keyDownArgs?.dispatchPickerCommand(plan)
      ]
      for (const pick of choose) {
        // The live editor can move ahead of the React draft before a pick lands.
        input.value = 'keep /pl tail'
        input.setSelectionRange(8, 8)
        await act(async () => pick())
        expect(transport.optionsSurface.setOption).toHaveBeenLastCalledWith(
          'interactionMode',
          'plan'
        )
        expect(mocks.setDraft).toHaveBeenLastCalledWith('keep  tail')
        expect(input.value).toBe('keep  tail')
        expect(input.selectionStart).toBe(5)
        expect(document.activeElement).toBe(input)
      }
      input.value = 'later typing'
      mocks.setDraft.mockClear()
      await act(async () => choose[0]!())
      expect(mocks.setDraft).not.toHaveBeenCalled()
      expect(transport.optionsSurface.setOption).toHaveBeenCalledTimes(3)
      input.blur()
      await act(async () => reply.resolve({ snapshot: [] }))
      expect(input.value).toBe('later typing')
      expect(document.activeElement).not.toBe(input)

      if (agent === 'codex') {
        mocks.draft = '/def'
        rerender()
        const leave = mocks.fieldProps?.autocomplete?.items?.find(
          (item) => item.kind === 'command' && item.name === 'default'
        )
        expect(leave).toBeDefined()
        input.value = '/def'
        input.setSelectionRange(4, 4)
        await act(async () => mocks.fieldProps?.onChoosePickerItem?.(leave!))
        expect(transport.optionsSurface.setOption).toHaveBeenLastCalledWith(
          'interactionMode',
          'default'
        )
        expect(input.value).toBe('')
      }
      expect(mocks.clearImageAttachments).not.toHaveBeenCalled()
      expect(transport.send).not.toHaveBeenCalled()
      expect(transport.dispatchCommand).not.toHaveBeenCalled()
      expect(mocks.sendNativeChatTypedCommand).not.toHaveBeenCalled()
    }
  )

  it('keeps a locked or transmitted mode pick intact even through a retained event callback', async () => {
    mocks.draft = '/pl'
    mocks.imageAttachments = [{ id: 'kept-image', path: '/tmp/kept.png' }]
    const { transport, rerender } = renderStructuredChat(undefined, 'codex')
    const controller = createStructuredSessionSelectionController(() => {})
    const view = createStructuredAgentSessionOptionState(
      'codex',
      structuredAgentSessionSeedCatalog('codex')
    )
    let ready = false
    const reply = Promise.withResolvers<{ kind: 'accepted'; options: Record<string, string> }>()
    const transmit = vi.fn(() => reply.promise)
    const writer = createStructuredAgentSessionOptionsWriteOwner(() => ({
      controller,
      record: view.record,
      view,
      snapshot: [MODE],
      ready,
      providerStarting: false,
      existingChat: true,
      isCurrentContext: () => true,
      flush: () => controller.flush(transmit),
      revalidate: () => {},
      revalidateOn: 'settled'
    }))
    transport.optionsSurface.admits = writer.admits
    vi.mocked(transport.optionsSurface.setOption).mockImplementation(async (id, value) => {
      await writer.setOption(id, value)
      return { snapshot: [MODE] }
    })
    transport.optionSnapshot = [MODE]
    rerender()
    const plan = mocks.fieldProps!.autocomplete!.items!.find((item) => item.name === 'plan')!
    const choose = mocks.fieldProps!.onChoosePickerItem!
    const input = document.querySelector('textarea')!
    input.value = 'keep /pl tail'
    input.setSelectionRange(8, 8)
    mocks.setDraft.mockClear()
    act(() => choose(plan))
    expect(input.value).toBe('keep /pl tail')
    expect(input.selectionStart).toBe(8)
    expect(mocks.setDraft).not.toHaveBeenCalled()
    expect(transmit).not.toHaveBeenCalled()
    ready = true
    act(() => choose(plan))
    expect(input.value).toBe('keep  tail')
    expect(transmit).toHaveBeenCalledTimes(1)
    input.value = 'keep /def tail'
    input.setSelectionRange(9, 9)
    const leave: CommandItem = {
      kind: 'command',
      id: 'command:default',
      name: 'default',
      token: '/default',
      skillCollision: false,
      orcaOwned: true
    }
    // No rerender: this callback still holds the enabled descriptor from before Plan was issued.
    act(() => choose(leave))
    expect(input.value).toBe('keep /def tail')
    expect(input.selectionStart).toBe(9)
    expect(transmit).toHaveBeenCalledTimes(1)
    await act(async () => reply.resolve({ kind: 'accepted', options: { interactionMode: 'plan' } }))
    await act(async () => choose(leave))
    expect(input.value).toBe('keep  tail')
    expect(transmit).toHaveBeenCalledTimes(2)
    expect(transport.send).not.toHaveBeenCalled()
    expect(mocks.clearImageAttachments).not.toHaveBeenCalled()
  })

  it('keeps namesake skills and a retained mode pick on an unsupported host as text', async () => {
    mocks.draft = '/pl'
    const { transport, rerender } = renderStructuredChat()
    transport.optionSnapshot = [MODE]
    rerender()
    const plan = mocks.fieldProps?.autocomplete?.items?.find((item) => item.name === 'plan')
    expect(plan).toBeDefined()
    await act(async () =>
      mocks.fieldProps?.onChoosePickerItem?.({
        kind: 'skill',
        id: 'skill:plan',
        name: 'plan',
        token: '/plan',
        description: null,
        sources: []
      })
    )
    expect(mocks.setDraft).toHaveBeenLastCalledWith('/plan ')
    transport.optionSnapshot = []
    rerender()
    const input = document.querySelector('textarea')!
    input.value = '/pl'
    input.setSelectionRange(3, 3)
    await act(async () => mocks.fieldProps?.onChoosePickerItem?.(plan!))
    expect(input.value).toBe('/plan ')
    expect(transport.optionsSurface.setOption).not.toHaveBeenCalled()
    expect(transport.send).not.toHaveBeenCalled()
  })

  it('rechecks a retained Plan command pick when the host starts owning mode changes', () => {
    mocks.draft = '/pl'
    const edit: QueuedMessageInlineEditor = {
      messageId: 'queued',
      draftScopeKey: 'queued-edit:plan-pick',
      text: '/pl',
      change: vi.fn(),
      acquiring: false,
      saving: false,
      canSave: true,
      imagesCapable: true,
      save: vi.fn(),
      cancel: vi.fn()
    }
    const { transport, rerender } = renderStructuredChat(edit)
    transport.sessionCommands = [{ name: 'plan', kind: 'command' }]
    rerender()
    const plan = mocks.fieldProps?.autocomplete?.items?.find((item) => item.name === 'plan')
    expect(plan).toBeDefined()
    act(() => mocks.fieldProps?.onChoosePickerItem?.(plan!))
    expect(mocks.setDraft).toHaveBeenCalledWith('/plan ')
    mocks.setDraft.mockClear()
    transport.optionSnapshot = [MODE]
    rerender()
    act(() => mocks.fieldProps?.onChoosePickerItem?.(plan!))
    expect(mocks.setDraft).not.toHaveBeenCalled()
    expect(transport.send).not.toHaveBeenCalled()
    expect(transport.dispatchCommand).not.toHaveBeenCalled()
  })

  it('offers usage only with host support and consumes a pick without dropping the remaining draft or attachments', () => {
    mocks.draft = '/usa'
    mocks.imageAttachments = [{ id: 'img-1', path: '/tmp/a.png' }]
    const { transport, rerender } = renderStructuredChat()
    expect(
      mocks.fieldProps?.autocomplete?.items?.some(
        (item) => item.name === 'usage' && item.kind === 'command'
      ) ?? false
    ).toBe(false)
    const open = vi.fn()
    transport.accountUsage = { open }
    rerender()
    expect(
      mocks.fieldProps?.autocomplete?.items?.some(
        (item) => item.name === 'usage' && item.kind === 'command'
      )
    ).toBe(true)
    mocks.draft = '/usa keep this draft'
    rerender()
    const select = vi.spyOn(HTMLTextAreaElement.prototype, 'setSelectionRange')
    act(() => mocks.keyDownArgs?.dispatchPickerCommand(USAGE))
    expect(open).toHaveBeenCalledOnce()
    expect(mocks.setDraft).toHaveBeenCalledWith('keep this draft')
    // The next keystroke lands after the kept text, not in front of it.
    expect(select).toHaveBeenLastCalledWith('keep this draft'.length, 'keep this draft'.length)
    select.mockRestore()
    expect(mocks.clearImageAttachments).not.toHaveBeenCalled()
    expect(transport.send).not.toHaveBeenCalled()
    mocks.draft = '/usage'
    rerender()
    act(() => mocks.fieldProps?.onSend?.())
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('keeps a picked skill named usage as a skill', () => {
    mocks.draft = '/usa'
    const { transport, rerender } = renderStructuredChat()
    const open = vi.fn()
    transport.accountUsage = { open }
    rerender()
    act(() =>
      mocks.fieldProps?.onChoosePickerItem?.({
        kind: 'skill',
        id: 'skill:usage',
        name: 'usage',
        token: '/usage',
        description: null,
        sources: []
      })
    )
    mocks.draft = '/usage'
    rerender()
    act(() => mocks.fieldProps?.onSend?.())
    expect(open).not.toHaveBeenCalled()
    expect(transport.dispatchCommand).toHaveBeenCalledWith('/usage')
    act(() => mocks.keyDownArgs?.dispatchPickerCommand(USAGE))
    expect(open).toHaveBeenCalledOnce()
  })
})

describe('/goal picked in a structured chat without host goals', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fieldProps = null
  })
  afterEach(() => cleanup())

  // Claude's pre-turn initialize rows are unclassified; only its built-in goal carries the marker.
  it.each([true, false])(
    'opens goal entry only for the provider built-in, builtin=%s',
    (builtin) => {
      mocks.draft = '/go'
      const { transport, rerender } = renderStructuredChat()
      transport.sessionCommands = [
        {
          name: 'goal',
          kind: 'command',
          kindUnspecified: true,
          description: 'Set a goal',
          ...(builtin ? { builtin: true as const } : {})
        }
      ]
      rerender()
      const goal = mocks.fieldProps?.autocomplete?.items?.find((item) => item.name === 'goal')
      expect(goal).toBeDefined()
      act(() => mocks.fieldProps?.onChoosePickerItem?.(goal!))
      expect(mocks.fieldProps?.goalMode?.active).toBe(builtin)
      expect(mocks.setDraft).toHaveBeenLastCalledWith(builtin ? '' : '/goal ')
      expect(transport.send).not.toHaveBeenCalled()
    }
  )
})
