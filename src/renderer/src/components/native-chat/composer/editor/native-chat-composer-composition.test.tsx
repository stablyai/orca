import { changePrompt, promptValue } from './native-chat-prompt-editor.test-support'
// @vitest-environment happy-dom

import { createRef } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as NativeI18n from '@/i18n/i18n'

vi.mock('@/i18n/i18n', async (original) => ({
  ...(await original<typeof NativeI18n>()),
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('../pickers/NativeChatAutocompleteMenus', () => ({
  NativeChatMentionMenu: () => null,
  NativeChatPickerMenu: () => null
}))

import {
  NativeChatComposerField,
  type NativeChatComposerFieldProps
} from './NativeChatComposerField'
import { useImeEnterGestureOwnership } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { TooltipProvider } from '@/components/ui/tooltip'

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

describe('native chat composer composition ownership', () => {
  it('preserves the focused preedit through a stale streaming rerender', () => {
    const textareaRef = createRef<HTMLTextAreaElement>()
    const onImeSettled = vi.fn()
    const props = fieldProps({ textareaRef, onImeSettled })
    const view = render(<TestField {...props} />)
    const input = textarea()
    input.focus()
    fireEvent.compositionStart(input)
    changePrompt(input, '가')

    view.rerender(<TestField {...props} draft="stale streaming draft" />)
    expect(textarea()).toBe(input)
    expect(document.activeElement).toBe(input)
    expect(promptValue(input)).toBe('가')

    fireEvent.compositionEnd(input, { data: '가' })
    expect(onImeSettled).toHaveBeenCalledOnce()
    expect(onImeSettled).toHaveBeenCalledWith(
      expect.objectContaining({ value: promptValue(input) })
    )
    expect(promptValue(input)).toBe('가')
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
})
