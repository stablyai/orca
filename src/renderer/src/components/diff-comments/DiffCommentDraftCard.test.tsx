// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { DiffCommentDraftCard } from './DiffCommentDraftCard'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))

describe('DiffCommentDraftCard', () => {
  let scrollHeight = 60

  beforeEach(() => {
    scrollHeight = 60
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(
      () => scrollHeight
    )
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('parks focus on the textarea before the pressed submit button turns disabled', async () => {
    let resolveSubmit: (result: boolean) => void = () => {}
    const onSubmit = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSubmit = resolve
        })
    )
    const view = render(
      <DiffCommentDraftCard lineNumber={10} onCancel={vi.fn()} onSubmit={onSubmit} />
    )
    const textarea = view.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'Pending note' } })
    const submitBtn = view.getByRole('button', { name: 'Add note' })
    submitBtn.focus()
    expect(document.activeElement).toBe(submitBtn)
    fireEvent.click(submitBtn)

    // Disabled buttons drop Chromium focus to body; preserve card focus so successful saves can return it to Monaco.
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(submitBtn.hasAttribute('disabled')).toBe(true)
    expect(document.activeElement).toBe(textarea)

    await act(async () => resolveSubmit(true))
  })

  it('calls onSubmit on Enter without Shift, but allows Shift+Enter for newlines', async () => {
    const onCancel = vi.fn()
    const onSubmit = vi.fn().mockResolvedValue(true)

    const view = render(
      <DiffCommentDraftCard lineNumber={10} onCancel={onCancel} onSubmit={onSubmit} />
    )

    const textarea = view.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'First line' } })

    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    })
    expect(onSubmit).toHaveBeenCalledWith('First line')
  })

  it('submits Cmd+Shift+Enter and ignores duplicate submits while pending', async () => {
    let resolveSubmit: (result: boolean) => void = () => {}
    const onSubmit = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSubmit = resolve
        })
    )
    const onCancel = vi.fn()
    const view = render(
      <DiffCommentDraftCard lineNumber={10} onCancel={onCancel} onSubmit={onSubmit} />
    )
    const textarea = view.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'Pending note' } })
    const submitButton = view.getByRole('button', { name: 'Add note' })

    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true, shiftKey: true })
    fireEvent.click(submitButton)
    fireEvent.keyDown(textarea, { key: 'Escape' })

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(view.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true)
    expect(onCancel).not.toHaveBeenCalled()

    await act(async () => resolveSubmit(true))
  })

  it('reports a rejected save to the user and re-enables the card', async () => {
    const error = new Error('network down')
    const onSubmit = vi.fn().mockRejectedValue(error)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = render(
      <DiffCommentDraftCard lineNumber={10} onCancel={vi.fn()} onSubmit={onSubmit} />
    )
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'Rejected note' } })

    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Add note' }))
    })

    expect(toast.error).toHaveBeenCalledWith('Failed to save comment')
    expect(consoleError).toHaveBeenCalled()
    expect(view.getByRole('button', { name: 'Add note' }).hasAttribute('disabled')).toBe(false)
  })

  it('does not submit on Enter when IME composition is active', async () => {
    const onCancel = vi.fn()
    const onSubmit = vi.fn().mockResolvedValue(true)

    const view = render(
      <DiffCommentDraftCard lineNumber={10} onCancel={onCancel} onSubmit={onSubmit} />
    )

    const textarea = view.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'nihon' } })

    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
