// @vitest-environment happy-dom

import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('./NativeChatComposerActions', () => ({
  NativeChatComposerActions: () => <div data-testid="composer-actions" />
}))

vi.mock('./NativeChatAutocompleteMenus', () => ({
  NativeChatMentionHint: () => null,
  NativeChatPickerMenu: () => null
}))

import {
  NativeChatComposerField,
  type NativeChatComposerFieldProps
} from './NativeChatComposerField'
import { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'

afterEach(() => cleanup())

type TestFieldProps = Omit<NativeChatComposerFieldProps, 'imeEnterGesture'>

function TestField(props: TestFieldProps): React.JSX.Element {
  const imeEnterGesture = useImeEnterGestureOwnership()
  return <NativeChatComposerField {...props} imeEnterGesture={imeEnterGesture} />
}

function fieldProps(overrides: Partial<TestFieldProps> = {}): TestFieldProps {
  return {
    textareaRef: createRef<HTMLTextAreaElement>(),
    draft: '',
    disabled: false,
    hasPty: true,
    canSend: true,
    autocomplete: { mode: 'none' },
    activeSuggestion: 0,
    notice: null,
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
    onAcceptMention: vi.fn(),
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
  it('preserves the focused browser preedit through 120 stale streaming rerenders', () => {
    const textareaRef = createRef<HTMLTextAreaElement>()
    const onImeSettled = vi.fn()
    const props = fieldProps({ textareaRef, onImeSettled })
    const view = render(<TestField {...props} />)
    const input = textarea()
    input.focus()
    fireEvent.compositionStart(input)
    input.value = '가'

    for (let index = 0; index < 120; index += 1) {
      view.rerender(<TestField {...props} draft={`stale streaming draft ${index}`} />)
      expect(textarea()).toBe(input)
      expect(document.activeElement).toBe(input)
      expect(input.value).toBe('가')
    }

    fireEvent.compositionEnd(input, { data: '가' })
    expect(onImeSettled).toHaveBeenCalledOnce()
    expect(onImeSettled).toHaveBeenCalledWith(input)
    expect(input.value).toBe('가')
  })

  it('synchronizes launch, programmatic, cleared, and pane-scoped drafts while idle', () => {
    const textareaRef = createRef<HTMLTextAreaElement>()
    const props = fieldProps({ textareaRef, draft: 'launch draft' })
    const view = render(<TestField {...props} />)
    const input = textarea()

    for (const draft of ['programmatic insertion', '', 'next pane draft']) {
      view.rerender(<TestField {...props} draft={draft} />)
      expect(textarea()).toBe(input)
      expect(input.value).toBe(draft)
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
    fireEvent.change(input, { target: { value: '한글' } })
    expect(onDraftChange).toHaveBeenLastCalledWith('한글', input)

    input.value = ''
    fireEvent.compositionEnd(input, { data: '' })
    expect(settledValue).toBe('')
  })

  it('uses the shared Enter gesture owner without swallowing the next deliberate Enter', () => {
    const onKeyDown = vi.fn()
    render(<TestField {...fieldProps({ draft: '가', onKeyDown })} />)
    const input = textarea()
    fireEvent.compositionStart(input)

    fireEvent.keyDown(input, { key: 'Process', keyCode: 229, isComposing: true })
    fireEvent.compositionEnd(input, { data: '가' })
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
    input.value = '각'

    fireEvent.blur(input)
    view.rerender(<TestField {...props} draft="external draft" />)
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, isComposing: false })

    expect(onImeSettled).toHaveBeenCalledOnce()
    expect(input.value).toBe('external draft')
    expect(onKeyDown).toHaveBeenCalledOnce()
  })

  it('settles the browser value instead of an unrelated draft rerender on blur', () => {
    const onImeSettled = vi.fn()
    const props = fieldProps({ onImeSettled })
    const view = render(<TestField {...props} />)
    const input = textarea()
    fireEvent.compositionStart(input)
    input.value = '각'

    view.rerender(<TestField {...props} draft="programmatic draft" />)
    expect(input.value).toBe('각')
    fireEvent.blur(input)

    expect(onImeSettled).toHaveBeenCalledOnce()
    expect(onImeSettled).toHaveBeenCalledWith(input)
    expect(input.value).toBe('각')
  })

  it('exposes the browser value on blur when compositionend is omitted', () => {
    const onImeSettled = vi.fn()
    render(<TestField {...fieldProps({ onImeSettled })} />)
    const input = textarea()
    fireEvent.compositionStart(input)
    input.value = '각'

    fireEvent.blur(input)

    expect(onImeSettled).toHaveBeenCalledOnce()
    expect(onImeSettled.mock.calls[0]?.[0].value).toBe('각')
  })

  it('settles once when compositionend and blur arrive in one batch', () => {
    const onImeSettled = vi.fn()
    render(<TestField {...fieldProps({ onImeSettled })} />)
    const input = textarea()
    fireEvent.compositionStart(input)
    input.value = '각'

    act(() => {
      fireEvent.compositionEnd(input, { data: '각' })
      fireEvent.blur(input)
    })

    expect(onImeSettled).toHaveBeenCalledOnce()
    expect(onImeSettled).toHaveBeenCalledWith(input)
  })

  it('settles once when blur precedes compositionend in one batch', () => {
    const onImeSettled = vi.fn()
    render(<TestField {...fieldProps({ onImeSettled })} />)
    const input = textarea()
    fireEvent.compositionStart(input)
    input.value = '각'

    act(() => {
      fireEvent.blur(input)
      fireEvent.compositionEnd(input, { data: '각' })
    })

    expect(onImeSettled).toHaveBeenCalledOnce()
    expect(onImeSettled).toHaveBeenCalledWith(input)
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
    input.value = '안녕하'
    view.rerender(<TestField {...props} draft="안녕하" />)

    // The accepted structured send lands while the next composition is still open.
    view.rerender(<TestField {...props} draft="" />)
    expect(input.value).toBe('안녕하')

    fireEvent.blur(input)
    expect(settledValue).toBe('하')
    expect(input.value).toBe('하')
  })

  it('forgets a dropped clear that the browser already settled', () => {
    const onImeSettled = vi.fn()
    const props = fieldProps({ draft: '안녕', onImeSettled })
    const view = render(<TestField {...props} />)
    const input = textarea()
    fireEvent.compositionStart(input)
    input.value = '안녕하'
    view.rerender(<TestField {...props} draft="" />)
    fireEvent.blur(input)

    // A second composition must not inherit the first one's clear.
    fireEvent.compositionStart(input)
    input.value = '하늘'
    fireEvent.blur(input)

    expect(input.value).toBe('하늘')
  })

  it('keeps the browser value through a same-draft streaming rerender', () => {
    const onImeSettled = vi.fn()
    const props = fieldProps({ onImeSettled })
    const view = render(<TestField {...props} />)
    const input = textarea()
    fireEvent.compositionStart(input)
    input.value = '각'

    view.rerender(<TestField {...props} />)
    fireEvent.blur(input)

    expect(input.value).toBe('각')
    expect(onImeSettled).toHaveBeenCalledWith(input)
  })
})
