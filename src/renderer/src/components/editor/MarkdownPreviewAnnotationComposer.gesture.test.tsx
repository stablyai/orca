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
vi.mock('./NotesSendMenu', () => ({ NotesSendMenu: () => null }))

import { MarkdownPreviewAnnotationComposer } from './MarkdownPreviewAnnotationComposer'

function renderComposer(): { onSubmit: ReturnType<typeof vi.fn>; textarea: HTMLTextAreaElement } {
  const onSubmit = vi.fn().mockResolvedValue(true)
  const view = render(
    <MarkdownPreviewAnnotationComposer lineNumber={1} onCancel={vi.fn()} onSubmit={onSubmit} />
  )
  const textarea = view.container.querySelector('textarea') as HTMLTextAreaElement
  fireEvent.change(textarea, { target: { value: 'a note for the agent' } })
  return { onSubmit, textarea }
}

describe('MarkdownPreviewAnnotationComposer submit gesture', () => {
  beforeEach(() => {
    state.gesture = 'enter'
  })
  afterEach(() => cleanup())

  it('default gesture: Enter submits, Shift+Enter is a newline', () => {
    const { onSubmit, textarea } = renderComposer()
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
    act(() => {
      fireEvent.keyDown(textarea, { key: 'Enter' })
    })
    expect(onSubmit).toHaveBeenCalledWith('a note for the agent')
  })

  it('remapped gesture: Enter is a newline, Alt+Enter and Cmd+Enter submit', () => {
    state.gesture = 'alt-enter'
    const { onSubmit, textarea } = renderComposer()
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
    act(() => {
      fireEvent.keyDown(textarea, { key: 'Enter', altKey: true })
    })
    expect(onSubmit).toHaveBeenCalledWith('a note for the agent')

    onSubmit.mockClear()
    const second = renderComposer()
    act(() => {
      fireEvent.keyDown(second.textarea, { key: 'Enter', metaKey: true })
    })
    expect(second.onSubmit).toHaveBeenCalledWith('a note for the agent')
  })
})
