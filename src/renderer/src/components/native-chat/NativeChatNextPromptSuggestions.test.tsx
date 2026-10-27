// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatNextPromptSuggestions } from './NativeChatNextPromptSuggestions'
import { NativeChatNextPromptsContext } from './native-chat-next-prompts-context'
import type { NativeChatComposerFieldProps } from './NativeChatComposerField'

afterEach(cleanup)

function mount(overrides: Partial<NativeChatComposerFieldProps> = {}) {
  const input = document.createElement('textarea')
  document.body.append(input)
  const submit = vi.fn((event: React.FormEvent) => event.preventDefault())
  const props = {
    textareaRef: { current: input },
    draft: '',
    disabled: false,
    canSend: true,
    isWorking: false,
    isStopping: false,
    imageAttachments: [],
    nextPromptsBlocked: false,
    imeEnterGesture: {
      isComposing: () => false,
      setComposing: vi.fn(),
      ownsKeyDown: vi.fn(() => false),
      onKeyUp: vi.fn(),
      onCompositionEnd: vi.fn(),
      reset: vi.fn()
    },
    onDraftChange: vi.fn(),
    ...overrides
  }
  render(
    <NativeChatNextPromptsContext value={['复核改动']}>
      <form onSubmit={submit}>
        <NativeChatNextPromptSuggestions {...props} />
      </form>
    </NativeChatNextPromptsContext>
  )
  return { input, submit, props }
}

describe('next prompt draft acceptance', () => {
  it('fills and focuses the editable draft, leaving the form unsent', () => {
    const { input, submit, props } = mount()
    fireEvent.click(screen.getByRole('button', { name: '复核改动' }))
    expect(input.value).toBe('复核改动')
    expect(input.selectionStart).toBe(input.value.length)
    expect(document.activeElement).toBe(input)
    expect(props.onDraftChange).toHaveBeenCalledWith('复核改动', input)
    expect(submit).not.toHaveBeenCalled()
  })

  it.each([
    { draft: 'My own draft' },
    { disabled: true },
    { canSend: false },
    { isWorking: true },
    { isStopping: true },
    { nextPromptsBlocked: true },
    { unavailableHint: 'Unavailable' },
    { imageAttachments: [{ id: 'img', path: '/image.png' }] }
  ])('hides suggestions when input is unavailable: %j', (overrides) => {
    mount(overrides)
    expect(screen.queryByRole('button', { name: '复核改动' })).toBeNull()
  })

  it.each(['typed', 'disabled', 'ime'])('rechecks the live editor on click: %s', (state) => {
    const { input, submit, props } = mount({
      imeEnterGesture: {
        isComposing: () => state === 'ime',
        setComposing: vi.fn(),
        ownsKeyDown: vi.fn(() => false),
        onKeyUp: vi.fn(),
        onCompositionEnd: vi.fn(),
        reset: vi.fn()
      }
    })
    if (state === 'typed') {
      input.value = 'Just typed'
    }
    if (state === 'disabled') {
      input.disabled = true
    }
    fireEvent.click(screen.getByRole('button', { name: '复核改动' }))
    expect(props.onDraftChange).not.toHaveBeenCalled()
    expect(input.value).toBe(state === 'typed' ? 'Just typed' : '')
    expect(submit).not.toHaveBeenCalled()
  })
})
