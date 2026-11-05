// @vitest-environment happy-dom

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
  goalMode?: { active: boolean }
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

import { NativeChatComposer } from './NativeChatComposer'

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
