// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  draft: '',
  setDraft: vi.fn(),
  setDraftWithoutPersist: vi.fn(),
  persistDraft: vi.fn(),
  fieldProps: null as ComposerFieldProps | null,
  pickerChange: vi.fn(),
  send: vi.fn()
}))

type CompositionEvent = { currentTarget: HTMLTextAreaElement }
type KeyEvent = {
  key: string
  shiftKey: boolean
  keyCode: number
  nativeEvent: { isComposing: boolean }
  preventDefault: () => void
}
type ComposerFieldProps = {
  onDraftChange: (value: string, element: HTMLTextAreaElement) => void
  onCompositionStart: () => void
  onCompositionEnd: (event: CompositionEvent) => void
  onKeyDown: (event: KeyEvent) => void
}

vi.mock('../../store', () => ({
  useAppStore: (
    selector: (value: {
      dictationState: string
      settings: { voice: { enabled: boolean } }
    }) => unknown
  ) => selector({ dictationState: 'idle', settings: { voice: { enabled: false } } })
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: vi.fn(),
  isRemoteRuntimePtyId: () => false
}))
vi.mock('@/lib/agent-paste-draft', () => ({ getSettingsForAgentTabRuntimeOwner: () => ({}) }))
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: (...args: unknown[]) => mocks.send(...args),
  sendNativeChatMessageWithImageAttachments: vi.fn(),
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('../../../../shared/native-chat-agent-profiles', () => ({
  getVerifiedNativeChatCommands: () => []
}))
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))
vi.mock('./use-native-chat-draft', () => ({
  useNativeChatDraft: () => ({
    draft: mocks.draft,
    setDraft: mocks.setDraft,
    setDraftWithoutPersist: mocks.setDraftWithoutPersist,
    persistDraft: mocks.persistDraft
  })
}))
vi.mock('./native-chat-draft-cache', () => ({ readNativeChatDraftCache: () => '' }))
vi.mock('./NativeChatComposerField', () => ({
  NativeChatComposerField: (props: ComposerFieldProps) => {
    mocks.fieldProps = props
    return null
  }
}))
vi.mock('./use-native-chat-composer-attachments', () => ({
  useNativeChatComposerAttachments: () => ({
    imageAttachments: [],
    attachResolvedPaths: vi.fn(),
    clearImageAttachments: vi.fn(),
    removeImageAttachment: vi.fn()
  })
}))
vi.mock('./use-native-chat-composer-paste', () => ({
  useNativeChatComposerPaste: () => ({ handlePaste: vi.fn(), pasteFromClipboard: vi.fn() })
}))
vi.mock('./use-native-chat-external-attachments', () => ({
  useNativeChatExternalAttachments: () => ({
    attachExternalPaths: vi.fn(),
    resolveAttachmentOwner: vi.fn()
  })
}))
vi.mock('./use-native-chat-send-lifecycle', () => ({
  useNativeChatSendLifecycle: () => ({ cancelPendingSends: vi.fn(), trackPendingSend: vi.fn() })
}))
vi.mock('./use-native-chat-session-options', () => ({
  useNativeChatSessionOptions: () => ({ surface: null, snapshot: [] })
}))
vi.mock('./use-native-chat-file-attachment-actions', () => ({
  useNativeChatFileAttachmentActions: () => ({ pickAttachment: vi.fn() })
}))
vi.mock('./use-native-chat-dictation-actions', () => ({
  useNativeChatDictationActions: () => ({
    toggleDictation: vi.fn(),
    startHoldDictation: vi.fn(),
    stopHoldDictation: vi.fn()
  })
}))
vi.mock('./use-native-chat-session-option-command', () => ({
  useNativeChatSessionOptionCommand: () => ({ dispatch: vi.fn(), isDispatching: false })
}))
vi.mock('./use-native-chat-picker-state', () => ({
  useNativeChatPickerState: () => ({
    autocomplete: { mode: 'none', items: [], query: '', triggerKey: '' },
    classifySend: () => 'chat',
    clearSkillOrigin: vi.fn(),
    completeItem: vi.fn(),
    dismiss: vi.fn(),
    handleDraftOrCaretChange: mocks.pickerChange,
    listboxId: 'picker',
    retrySkills: vi.fn()
  })
}))
vi.mock('./use-native-chat-picker-command-dispatch', () => ({
  useNativeChatPickerCommandDispatch: () => vi.fn()
}))
vi.mock('./use-native-chat-typed-insertion', () => ({
  useNativeChatTypedInsertion: () => ({
    insertTypedText: vi.fn(),
    focus: vi.fn()
  })
}))

import { NativeChatComposer } from './NativeChatComposer'

const element = (value: string): HTMLTextAreaElement =>
  ({ value, selectionStart: value.length }) as HTMLTextAreaElement

describe('NativeChatComposer IME composition', () => {
  let rerenderComposer: ReturnType<typeof render>['rerender']

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fieldProps = null
    mocks.draft = ''
    rerenderComposer = render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId="pty-1"
        agent="codex"
      />
    ).rerender
  })

  afterEach(() => cleanup())

  it('defers side effects until composition end', () => {
    act(() => mocks.fieldProps?.onCompositionStart())
    act(() => mocks.fieldProps?.onDraftChange('ㅎ', element('ㅎ')))
    act(() => mocks.fieldProps?.onDraftChange('한', element('한')))

    expect(mocks.setDraftWithoutPersist).toHaveBeenCalledTimes(2)
    expect(mocks.persistDraft).not.toHaveBeenCalled()
    expect(mocks.pickerChange).not.toHaveBeenCalled()
  })

  it('flushes confirmed text once on composition end', () => {
    const textarea = element('한')
    act(() => mocks.fieldProps?.onCompositionStart())
    act(() => mocks.fieldProps?.onDraftChange('ㅎ', element('ㅎ')))
    act(() => mocks.fieldProps?.onCompositionEnd({ currentTarget: textarea }))
    act(() => mocks.fieldProps?.onDraftChange('한', textarea))

    expect(mocks.persistDraft).toHaveBeenCalledOnce()
    expect(mocks.persistDraft).toHaveBeenCalledWith('한')
    expect(mocks.pickerChange).toHaveBeenCalledOnce()
  })

  it('keeps non-composition typing behavior unchanged', () => {
    act(() => mocks.fieldProps?.onDraftChange('a', element('a')))

    expect(mocks.setDraft).toHaveBeenCalledWith('a')
    expect(mocks.pickerChange).toHaveBeenCalledWith('a', 1)
  })

  it('resets composition state when switching panes', () => {
    act(() => mocks.fieldProps?.onCompositionStart())
    act(() => mocks.fieldProps?.onDraftChange('ㅎ', element('ㅎ')))

    act(() =>
      rerenderComposer(
        <NativeChatComposer
          terminalTabId="tab-1"
          paneKey="tab-1:leaf-2"
          targetPtyId="pty-2"
          agent="codex"
        />
      )
    )
    act(() => mocks.fieldProps?.onDraftChange('b', element('b')))

    expect(mocks.setDraft).toHaveBeenCalledWith('b')
    expect(mocks.pickerChange).toHaveBeenCalledWith('b', 1)
  })

  it('keeps enter submit and shift-enter newline unchanged', () => {
    mocks.draft = 'hello'
    act(() =>
      rerenderComposer(
        <NativeChatComposer
          terminalTabId="tab-1"
          paneKey="tab-1:leaf-1"
          targetPtyId="pty-1"
          agent="codex"
        />
      )
    )

    const preventDefault = vi.fn()
    act(() =>
      mocks.fieldProps?.onKeyDown({
        key: 'Enter',
        shiftKey: false,
        keyCode: 13,
        nativeEvent: { isComposing: false },
        preventDefault
      })
    )
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(mocks.send).toHaveBeenCalledOnce()
    expect(mocks.send).toHaveBeenCalledWith({}, 'pty-1', 'hello')

    mocks.send.mockClear()
    preventDefault.mockClear()
    act(() =>
      mocks.fieldProps?.onKeyDown({
        key: 'Enter',
        shiftKey: true,
        keyCode: 13,
        nativeEvent: { isComposing: false },
        preventDefault
      })
    )
    expect(preventDefault).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })
})
