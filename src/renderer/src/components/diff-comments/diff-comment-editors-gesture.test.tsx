// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ gesture: 'enter' as 'enter' | 'alt-enter' | 'ctrl-j' }))

// Control the resolved gesture; keep the real hook + matcher + component wiring.
vi.mock('@/components/native-chat/native-chat-claude-submit-cache', () => ({
  getClaudeSubmitGesture: () => state.gesture,
  primeClaudeSubmit: vi.fn(),
  primeComposerSubmitBytes: vi.fn(),
  agentResolvesSubmitKeybinding: () => true
}))

import { DiffCommentPopover } from './DiffCommentPopover'
import { DiffCommentCard } from './DiffCommentCard'

function textareaOf(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector('textarea') as HTMLTextAreaElement
}

describe('DiffCommentPopover submit gesture', () => {
  beforeEach(() => {
    state.gesture = 'enter'
  })
  afterEach(() => cleanup())

  function renderPopover(): { onSubmit: ReturnType<typeof vi.fn>; textarea: HTMLTextAreaElement } {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const view = render(
      <DiffCommentPopover lineNumber={1} top={0} onCancel={vi.fn()} onSubmit={onSubmit} />
    )
    const textarea = textareaOf(view.container)
    fireEvent.change(textarea, { target: { value: 'a diff note' } })
    return { onSubmit, textarea }
  }

  it('default gesture: Enter submits, Shift+Enter is a newline', () => {
    const { onSubmit, textarea } = renderPopover()
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
    act(() => {
      fireEvent.keyDown(textarea, { key: 'Enter' })
    })
    expect(onSubmit).toHaveBeenCalledWith('a diff note')
  })

  it('remapped gesture: Enter is a newline, Alt+Enter submits', () => {
    state.gesture = 'alt-enter'
    const { onSubmit, textarea } = renderPopover()
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
    act(() => {
      fireEvent.keyDown(textarea, { key: 'Enter', altKey: true })
    })
    expect(onSubmit).toHaveBeenCalledWith('a diff note')
  })
})

describe('DiffCommentCard edit submit gesture', () => {
  beforeEach(() => {
    state.gesture = 'enter'
  })
  afterEach(() => cleanup())

  function renderEditingCard(): {
    onSubmitEdit: ReturnType<typeof vi.fn>
    textarea: HTMLTextAreaElement
  } {
    const onSubmitEdit = vi.fn().mockResolvedValue(true)
    const view = render(
      <DiffCommentCard lineNumber={1} body="original note" onSubmitEdit={onSubmitEdit} />
    )
    // Enter edit mode via the Edit button, then change the draft so it differs from the body.
    const editButton = view.container.querySelector(
      'button[aria-label="Edit note"]'
    ) as HTMLButtonElement
    fireEvent.click(editButton)
    const textarea = textareaOf(view.container)
    fireEvent.change(textarea, { target: { value: 'edited note' } })
    return { onSubmitEdit, textarea }
  }

  it('default gesture: Enter submits the edit', () => {
    const { onSubmitEdit, textarea } = renderEditingCard()
    act(() => {
      fireEvent.keyDown(textarea, { key: 'Enter' })
    })
    expect(onSubmitEdit).toHaveBeenCalledWith('edited note')
  })

  it('remapped gesture: Enter is a newline, Alt+Enter submits the edit', () => {
    state.gesture = 'alt-enter'
    const { onSubmitEdit, textarea } = renderEditingCard()
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSubmitEdit).not.toHaveBeenCalled()
    act(() => {
      fireEvent.keyDown(textarea, { key: 'Enter', altKey: true })
    })
    expect(onSubmitEdit).toHaveBeenCalledWith('edited note')
  })
})
