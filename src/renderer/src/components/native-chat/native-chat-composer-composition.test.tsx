import { endComposition } from '@/lib/ime-composition-event.test-support'
import { changePrompt, promptValue } from './native-chat-prompt-editor.test-support'
// @vitest-environment happy-dom

import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as NativeI18n from '@/i18n/i18n'

vi.mock('@/i18n/i18n', async (original) => ({
  ...(await original<typeof NativeI18n>()),
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('./NativeChatAutocompleteMenus', () => ({
  NativeChatMentionMenu: () => null,
  NativeChatPickerMenu: () => null
}))

import {
  NativeChatComposerField,
  type NativeChatComposerFieldProps
} from './NativeChatComposerField'
import { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useNativeChatDraft } from './use-native-chat-draft'
import { useNativeChatDraftEvents } from './use-native-chat-draft-events'
import { useNativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import {
  createNativeChatQueuedEditDraft,
  handBackNativeChatQueuedEdit,
  discardNativeChatQueuedEdit
} from './native-chat-queued-edit-draft'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft,
  clearNativeChatComposerDraftsForTests,
  hydrateNativeChatComposerDrafts,
  nativeChatComposerDraftWritesSettled
} from './native-chat-composer-draft-store'
import { appendNativeChatDraftCache } from './native-chat-draft-cache'
import { settleNativeChatPastedText } from './native-chat-composer-pasted-text-references'
import {
  nativeChatPastedTextOperations,
  nativeChatPastedTextToken
} from './native-chat-pasted-text-reference'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from './native-chat-composer-draft-storage'
import { promptSkillRefs } from './native-chat-prompt-document'
import { dispatchStructuredAgentSessionComposerCommand } from '../../../../shared/structured-agent-session-composer'

afterEach(() => cleanup())

type TestFieldProps = Omit<NativeChatComposerFieldProps, 'imeEnterGesture'>

function TestField(props: TestFieldProps): React.JSX.Element {
  const imeEnterGesture = useImeEnterGestureOwnership()
  return (
    <TooltipProvider>
      <NativeChatComposerField {...props} imeEnterGesture={imeEnterGesture} />
    </TooltipProvider>
  )
}

function fieldProps(overrides: Partial<TestFieldProps> = {}): TestFieldProps {
  return {
    draftScopeKey: 'pane-test',
    textareaRef: createRef<HTMLTextAreaElement>(),
    draft: '',
    disabled: false,
    hasPty: true,
    canSend: true,
    autocomplete: { mode: 'none' },
    activeSuggestion: 0,
    notices: [],
    imageAttachments: [],
    sendButtonDisabled: false,
    isWorking: false,
    attachDisabled: false,
    dictationDisabled: false,
    isDictating: false,
    isDictationHoldMode: false,
    onDraftChange: vi.fn(),
    onTextareaSelect: vi.fn(),
    onKeyDown: vi.fn(),
    onImeSettled: vi.fn(),
    onPaste: vi.fn(),
    pickerListboxId: 'picker',
    onChoosePickerItem: vi.fn(),
    onRetrySkills: vi.fn(),
    onChooseMentionFile: vi.fn(),
    mentionFiles: { files: [], loading: false, failed: false },
    onRemoveImageAttachment: vi.fn(),
    onAttach: vi.fn(),
    onDictationToggle: vi.fn(),
    onDictationHoldStart: vi.fn(),
    onDictationHoldEnd: vi.fn(),
    onSend: vi.fn(),
    sessionOptionsSurface: null,
    sessionOptionsSnapshot: [],
    ...overrides
  }
}

function textarea(): HTMLTextAreaElement {
  return screen.getByRole('textbox') as HTMLTextAreaElement
}

describe('native chat composer drop ownership', () => {
  it('keeps the conversation editor key without publishing drop routing markers', () => {
    const view = render(<TestField {...fieldProps({ draftScopeKey: 'agent-session:session-9' })} />)
    expect(view.container.querySelector('[data-composer-scope-key]')).toBeNull()
    expect(view.container.querySelector('.ProseMirror')).not.toBeNull()
  })
})

describe('queued edit placeholder ownership', () => {
  it('names the edit while locally locked, keeping Cancel available and bottom copy unchanged', () => {
    const cancel = vi.fn()
    const props = fieldProps({
      draftScopeKey: 'queued-edit:image-only',
      editSession: { cancel },
      imageAttachments: [
        { id: 'retained-image', path: '/image.png', previewUrl: 'data:image/png;base64,AA==' }
      ],
      disabled: true,
      canSend: false,
      sendButtonDisabled: true,
      attachDisabled: true,
      dictationDisabled: true
    })
    const view = render(<TestField {...props} />)

    expect(
      screen.getByRole('textbox', { name: 'Edit message' }).getAttribute('contenteditable')
    ).toBe('false')
    expect(view.container.querySelector('[data-placeholder="Edit message"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
    const cancelButton = screen.getByRole('button', { name: 'Cancel' })
    expect(cancelButton.hasAttribute('disabled')).toBe(false)

    view.rerender(<TestField {...props} disabled={false} canSend sendButtonDisabled={false} />)
    expect(
      screen.getByRole('textbox', { name: 'Edit message' }).getAttribute('contenteditable')
    ).toBe('true')
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false)
    view.rerender(<TestField {...props} />)
    expect(
      screen.getByRole('textbox', { name: 'Edit message' }).getAttribute('contenteditable')
    ).toBe('false')
    expect(view.container.querySelector('[data-placeholder="Edit message"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
    expect(cancelButton.hasAttribute('disabled')).toBe(false)
    fireEvent.click(cancelButton)
    expect(cancel).toHaveBeenCalledOnce()

    view.rerender(
      <TestField {...props} editSession={undefined} draftScopeKey="agent-session:bottom" />
    )
    expect(screen.getByRole('textbox', { name: 'Input is held by another device.' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })
})

describe('native chat composer composition ownership', () => {
  it('preserves the focused browser preedit through 120 stale streaming rerenders', () => {
    const textareaRef = createRef<HTMLTextAreaElement>()
    const onImeSettled = vi.fn()
    const props = fieldProps({ textareaRef, onImeSettled })
    const view = render(<TestField {...props} />)
    const input = textarea()
    input.focus()
    fireEvent.compositionStart(input)
    changePrompt(input, '가')

    for (let index = 0; index < 120; index += 1) {
      view.rerender(<TestField {...props} draft={`stale streaming draft ${index}`} />)
      expect(textarea()).toBe(input)
      expect(document.activeElement).toBe(input)
      expect(promptValue(input)).toBe('가')
    }

    fireEvent.compositionEnd(input, { data: '가' })
    expect(onImeSettled).toHaveBeenCalledOnce()
    expect(onImeSettled).toHaveBeenCalledWith(
      expect.objectContaining({ value: promptValue(input) })
    )
    expect(promptValue(input)).toBe('가')
  })

  it('synchronizes launch, programmatic, cleared, and pane-scoped drafts while idle', () => {
    const textareaRef = createRef<HTMLTextAreaElement>()
    const props = fieldProps({ textareaRef, draft: 'launch draft' })
    const view = render(<TestField {...props} />)
    const input = textarea()

    for (const draft of ['programmatic insertion', '', 'next pane draft']) {
      view.rerender(<TestField {...props} draft={draft} />)
      expect(textarea()).toBe(input)
      expect(promptValue(input)).toBe(draft)
    }
  })

  it('keeps adopting change events and exposes the final deletion at composition end', () => {
    const onDraftChange = vi.fn()
    let settledValue: string | null = null
    render(
      <TestField
        {...fieldProps({
          draft: '한',
          onDraftChange,
          onImeSettled: (element) => {
            settledValue = element.value
          }
        })}
      />
    )
    const input = textarea()
    fireEvent.compositionStart(input)
    changePrompt(input, '한글')
    expect(onDraftChange).toHaveBeenLastCalledWith(
      '한글',
      expect.objectContaining({ value: '한글' })
    )

    changePrompt(input, '')
    fireEvent.compositionEnd(input, { data: '' })
    expect(settledValue).toBe('')
  })

  it('swallows the Enter that confirms a Japanese candidate without eating the next one', () => {
    const onKeyDown = vi.fn()
    render(<TestField {...fieldProps({ draft: '日本語', onKeyDown })} />)
    const input = textarea()
    fireEvent.compositionStart(input)

    fireEvent.keyDown(input, { key: 'Process', keyCode: 229, isComposing: true })
    endComposition(input, '日本語')
    const redispatch = fireEvent.keyDown(input, {
      key: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(redispatch).toBe(false)
    expect(onKeyDown).not.toHaveBeenCalled()

    fireEvent.keyUp(input, { key: 'Enter', keyCode: 13 })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, isComposing: false })
    expect(onKeyDown).toHaveBeenCalledOnce()
  })

  it('releases composition ownership on blur even when compositionend is omitted', () => {
    const onImeSettled = vi.fn()
    const onKeyDown = vi.fn()
    const props = fieldProps({ draft: '가', onImeSettled, onKeyDown })
    const view = render(<TestField {...props} />)
    const input = textarea()
    fireEvent.compositionStart(input)
    changePrompt(input, '각')

    fireEvent.blur(input)
    view.rerender(<TestField {...props} draft="external draft" />)
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, isComposing: false })

    expect(onImeSettled).toHaveBeenCalledOnce()
    expect(promptValue(input)).toBe('external draft')
    expect(onKeyDown).toHaveBeenCalledOnce()
  })

  it('settles the browser value instead of an unrelated draft rerender on blur', () => {
    const onImeSettled = vi.fn()
    const props = fieldProps({ onImeSettled })
    const view = render(<TestField {...props} />)
    const input = textarea()
    fireEvent.compositionStart(input)
    changePrompt(input, '각')

    view.rerender(<TestField {...props} draft="programmatic draft" />)
    expect(promptValue(input)).toBe('각')
    fireEvent.blur(input)

    expect(onImeSettled).toHaveBeenCalledOnce()
    expect(onImeSettled).toHaveBeenCalledWith(
      expect.objectContaining({ value: promptValue(input) })
    )
    expect(promptValue(input)).toBe('각')
  })

  it('exposes the browser value on blur when compositionend is omitted', () => {
    const onImeSettled = vi.fn()
    render(<TestField {...fieldProps({ onImeSettled })} />)
    const input = textarea()
    fireEvent.compositionStart(input)
    changePrompt(input, '각')

    fireEvent.blur(input)

    expect(onImeSettled).toHaveBeenCalledOnce()
    expect(onImeSettled.mock.calls[0]?.[0].value).toBe('각')
  })

  it('settles once when compositionend and blur arrive in one batch', () => {
    const onImeSettled = vi.fn()
    render(<TestField {...fieldProps({ onImeSettled })} />)
    const input = textarea()
    fireEvent.compositionStart(input)
    changePrompt(input, '각')

    act(() => {
      fireEvent.compositionEnd(input, { data: '각' })
      fireEvent.blur(input)
    })

    expect(onImeSettled).toHaveBeenCalledOnce()
    expect(onImeSettled).toHaveBeenCalledWith(
      expect.objectContaining({ value: promptValue(input) })
    )
  })

  it('settles once when blur precedes compositionend in one batch', () => {
    const onImeSettled = vi.fn()
    render(<TestField {...fieldProps({ onImeSettled })} />)
    const input = textarea()
    fireEvent.compositionStart(input)
    changePrompt(input, '각')

    act(() => {
      fireEvent.blur(input)
      fireEvent.compositionEnd(input, { data: '각' })
    })

    expect(onImeSettled).toHaveBeenCalledOnce()
    expect(onImeSettled).toHaveBeenCalledWith(
      expect.objectContaining({ value: promptValue(input) })
    )
  })

  it('replays a draft clear dropped mid-composition when the field settles on blur', () => {
    let settledValue: string | null = null
    const props = fieldProps({
      draft: '안녕',
      onImeSettled: (element) => {
        settledValue = element.value
      }
    })
    const view = render(<TestField {...props} />)
    const input = textarea()
    fireEvent.compositionStart(input)
    changePrompt(input, '안녕하')
    view.rerender(<TestField {...props} draft="안녕하" />)

    // The accepted structured send lands while the next composition is still open.
    view.rerender(<TestField {...props} draft="" />)
    expect(promptValue(input)).toBe('안녕하')

    fireEvent.blur(input)
    expect(settledValue).toBe('하')
    expect(promptValue(input)).toBe('하')
  })

  it('forgets a dropped clear that the browser already settled', () => {
    const onImeSettled = vi.fn()
    const props = fieldProps({ draft: '안녕', onImeSettled })
    const view = render(<TestField {...props} />)
    const input = textarea()
    fireEvent.compositionStart(input)
    changePrompt(input, '안녕하')
    view.rerender(<TestField {...props} draft="" />)
    fireEvent.blur(input)

    // A second composition must not inherit the first one's clear.
    fireEvent.compositionStart(input)
    changePrompt(input, '하늘')
    fireEvent.blur(input)

    expect(promptValue(input)).toBe('하늘')
  })

  it('keeps the browser value through a same-draft streaming rerender', () => {
    const onImeSettled = vi.fn()
    const props = fieldProps({ onImeSettled })
    const view = render(<TestField {...props} />)
    const input = textarea()
    fireEvent.compositionStart(input)
    changePrompt(input, '각')

    view.rerender(<TestField {...props} />)
    fireEvent.blur(input)

    expect(promptValue(input)).toBe('각')
    expect(onImeSettled).toHaveBeenCalledWith(
      expect.objectContaining({ value: promptValue(input) })
    )
  })
})

it('keeps an actual composing return through command acceptance, composition settlement and the next real Send', async () => {
  clearNativeChatComposerDraftsForTests()
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  await hydrateNativeChatComposerDrafts()
  const scope = 'agent-session:composition-return'
  updateNativeChatComposerDraft(scope, { text: '/goal ship it' }, 'immediate')
  const reply = Promise.withResolvers<boolean>()
  const transport: NativeChatStructuredComposerTransport = {
    capturePresentation: () => () => true,
    send: vi.fn(() => true),
    threadGoal: { setObjective: () => reply.promise },
    dispatchCommand: (text) =>
      dispatchStructuredAgentSessionComposerCommand(text, {
        agent: 'codex',
        snapshot: [],
        invokeAction: async () => true,
        setOption: async () => true,
        setThreadGoalObjective: () => reply.promise
      }),
    optionsSurface: {
      getSnapshot: () => [],
      setOption: vi.fn(),
      invokeAction: vi.fn(),
      subscribe: () => () => {}
    },
    optionSnapshot: [],
    onError: vi.fn(),
    runtime: 'local',
    sessionId: 'composition-return',
    runtimeEnvironmentId: null
  }
  let send: ReturnType<typeof useNativeChatStructuredComposerSend> | undefined
  const input = createRef<NativeChatComposerFieldProps['textareaRef']['current']>()
  function JoinedField() {
    const ime = useImeEnterGestureOwnership()
    const draft = useNativeChatDraft(scope, ime.isComposing)
    send = useNativeChatStructuredComposerSend({
      agent: 'codex',
      draftScopeKey: scope,
      imageAttachments: [],
      structuredTransport: transport,
      isComposing: ime.isComposing,
      setDraft: draft.setDraft,
      setCaret: vi.fn(),
      clearSkillOrigin: vi.fn()
    })
    const events = useNativeChatDraftEvents({
      ...draft,
      setCaret: vi.fn(),
      setActiveSuggestion: vi.fn(),
      handleDraftOrCaretChange: vi.fn(),
      flushPendingAttachments: vi.fn()
    })
    return (
      <TooltipProvider>
        <NativeChatComposerField
          {...fieldProps()}
          textareaRef={input}
          draftScopeKey={scope}
          draft={draft.draft}
          imeEnterGesture={ime}
          {...events}
        />
      </TooltipProvider>
    )
  }
  const view = render(<JoinedField />)
  let pending: Promise<void> | undefined
  act(() => {
    pending = send!('/goal ship it', [])
  })
  const field = screen.getByRole('textbox')
  fireEvent.compositionStart(field)
  changePrompt(field, '/goal ship it가')
  const edit = createNativeChatQueuedEditDraft(
    {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: '$review' }],
      skills: [{ name: 'review', path: '/ime/SKILL.md' }]
    },
    scope
  )
  act(() => {
    const draft = readNativeChatComposerDraft(edit.scopeKey)
    updateNativeChatComposerDraft(
      edit.scopeKey,
      {
        text: '$review changed',
        document: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                ...(draft.document?.content?.[0].content ?? []),
                { type: 'text', text: ' changed' }
              ]
            }
          ]
        }
      },
      'immediate'
    )
    handBackNativeChatQueuedEdit(edit)
    discardNativeChatQueuedEdit(edit)
  })
  expect(promptValue(field)).toBe('/goal ship it가')
  await act(async () => {
    reply.resolve(true)
    await pending
  })
  expect(promptValue(field)).toBe('/goal ship it가')
  fireEvent.compositionEnd(field, { data: '가' })
  expect(promptValue(field)).toBe('가\n\n$review changed')
  const left = readNativeChatComposerDraft(scope)
  expect(left.text).toBe('가\n\n$review changed')
  expect(promptSkillRefs(left.document)).toEqual([{ name: 'review', path: '/ime/SKILL.md' }])
  await act(async () => send!(left.text, []))
  expect(transport.send).toHaveBeenCalledExactlyOnceWith(left.text, [], {
    skills: [{ name: 'review', path: '/ime/SKILL.md' }]
  })
  view.unmount()
  clearNativeChatComposerDraftsForTests()
})

describe('an open IME composition stays in the draft every consumer reads (#35836)', () => {
  const scope = 'agent-session:open-composition'
  let storage: ReturnType<typeof createMemoryNativeChatComposerDraftStorage>

  beforeEach(async () => {
    clearNativeChatComposerDraftsForTests()
    storage = createMemoryNativeChatComposerDraftStorage()
    setNativeChatComposerDraftStorageForTests(storage)
    await hydrateNativeChatComposerDrafts()
  })
  afterEach(() => {
    cleanup()
    clearNativeChatComposerDraftsForTests()
    nativeChatPastedTextOperations.clear()
  })

  // The pane's Send reads its React draft, as this field's Send does.
  function LiveField({ onSend = vi.fn() }: { onSend?: (text: string) => void }) {
    const ime = useImeEnterGestureOwnership()
    const draft = useNativeChatDraft(scope, ime.isComposing)
    const events = useNativeChatDraftEvents({
      ...draft,
      setCaret: vi.fn(),
      setActiveSuggestion: vi.fn(),
      handleDraftOrCaretChange: vi.fn(),
      flushPendingAttachments: vi.fn()
    })
    return (
      <TooltipProvider>
        <NativeChatComposerField
          {...fieldProps()}
          draftScopeKey={scope}
          draft={draft.draft}
          imeEnterGesture={ime}
          sendButtonDisabled={draft.draft.trim() === ''}
          onSend={() => onSend(draft.draft)}
          {...events}
        />
      </TooltipProvider>
    )
  }

  it('sends the composing text from a Send press that keeps focus', () => {
    const onSend = vi.fn()
    render(<LiveField onSend={onSend} />)
    const field = textarea()
    fireEvent.compositionStart(field)
    changePrompt(field, 'nihao')

    const sendButton = screen.getByRole('button', { name: 'Send' })
    expect(sendButton.hasAttribute('disabled')).toBe(false)
    fireEvent.mouseDown(sendButton)
    fireEvent.click(sendButton)
    expect(onSend).toHaveBeenCalledExactlyOnceWith('nihao')
  })

  it('keeps a message returned mid-composition when the composer unmounts', () => {
    const view = render(<LiveField />)
    const field = textarea()
    fireEvent.compositionStart(field)
    changePrompt(field, '가')
    act(() => {
      appendNativeChatDraftCache(scope, 'returned message')
    })

    view.unmount()
    expect(readNativeChatComposerDraft(scope).text).toBe('가\n\nreturned message')
  })

  it('saves edits made after a composition that blur ended without compositionend', () => {
    render(<LiveField />)
    const field = textarea()
    fireEvent.compositionStart(field)
    changePrompt(field, '각')
    fireEvent.blur(field)
    changePrompt(field, '각a')

    expect(readNativeChatComposerDraft(scope).text).toBe('각a')
  })

  it('keeps a pasted-text path that finished saving mid-composition', () => {
    const id = '00000000-0000-4000-8000-000000000035'
    const token = nativeChatPastedTextToken(id)
    nativeChatPastedTextOperations.set(id, { scopeKey: scope, text: 'pasted' })
    updateNativeChatComposerDraft(scope, { text: token }, 'immediate')
    render(<LiveField />)
    const field = textarea()
    fireEvent.compositionStart(field)
    changePrompt(field, `${token} ni`)
    act(() => {
      settleNativeChatPastedText(id, '/tmp/pasted.txt')
    })
    endComposition(field, 'ni')

    expect(readNativeChatComposerDraft(scope).pastedTextFiles).toEqual({ [id]: '/tmp/pasted.txt' })
  })

  it('saves the composing text when the window hides mid-composition', async () => {
    render(<LiveField />)
    const field = textarea()
    fireEvent.compositionStart(field)
    changePrompt(field, 'nihao')

    window.dispatchEvent(new Event('pagehide'))
    await nativeChatComposerDraftWritesSettled()
    expect(storage.drafts.get(scope)?.text).toBe('nihao')
  })
})
