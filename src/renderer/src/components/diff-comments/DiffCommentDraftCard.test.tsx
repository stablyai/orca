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

  it('renders line header', () => {
    const onCancel = vi.fn()
    const onSubmit = vi.fn().mockResolvedValue(true)

    const view = render(
      <DiffCommentDraftCard lineNumber={42} onCancel={onCancel} onSubmit={onSubmit} />
    )

    expect(view.getByText('Line 42')).toBeDefined()
    expect(view.queryByText('You')).toBeNull()
    const textarea = view.getByPlaceholderText('Add note for the AI')
    expect(textarea).toBeDefined()
    expect(document.activeElement).toBe(textarea)
    expect(view.getByRole('button', { name: 'Add note' })).toBeDefined()
    expect(view.getByRole('button', { name: 'Cancel' })).toBeDefined()
  })

  it('renders range header when startLine is provided', () => {
    const onCancel = vi.fn()
    const onSubmit = vi.fn().mockResolvedValue(true)

    const view = render(
      <DiffCommentDraftCard
        lineNumber={42}
        startLine={38}
        onCancel={onCancel}
        onSubmit={onSubmit}
      />
    )

    expect(view.getByText('Lines 38-42')).toBeDefined()
  })

  it('disables submit button when body is whitespace and enables when text is typed', () => {
    const onCancel = vi.fn()
    const onSubmit = vi.fn().mockResolvedValue(true)

    const view = render(
      <DiffCommentDraftCard lineNumber={10} onCancel={onCancel} onSubmit={onSubmit} />
    )

    const submitBtn = view.getByRole('button', { name: 'Add note' })
    expect(submitBtn.hasAttribute('disabled')).toBe(true)

    const textarea = view.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '   ' } })
    expect(submitBtn.hasAttribute('disabled')).toBe(true)

    fireEvent.change(textarea, { target: { value: 'Refactor this loop' } })
    expect(submitBtn.hasAttribute('disabled')).toBe(false)
  })

  it('calls onSubmit when clicking submit button', async () => {
    const onCancel = vi.fn()
    const onSubmit = vi.fn().mockResolvedValue(true)

    const view = render(
      <DiffCommentDraftCard lineNumber={10} onCancel={onCancel} onSubmit={onSubmit} />
    )

    const textarea = view.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'Needs revision' } })

    const submitBtn = view.getByRole('button', { name: 'Add note' })
    await act(async () => {
      fireEvent.click(submitBtn)
    })

    expect(onSubmit).toHaveBeenCalledWith('Needs revision')
  })

  it('calls onSubmit on Enter without Shift, but allows Shift+Enter for newlines', async () => {
    const onCancel = vi.fn()
    const onSubmit = vi.fn().mockResolvedValue(true)

    const view = render(
      <DiffCommentDraftCard lineNumber={10} onCancel={onCancel} onSubmit={onSubmit} />
    )

    const textarea = view.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'First line' } })

    // Shift+Enter should NOT submit
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()

    // Plain Enter SHOULD submit
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

  it('seeds and reports draft text so a re-anchored card can carry it', () => {
    const onBodyChange = vi.fn()
    const view = render(
      <DiffCommentDraftCard
        lineNumber={10}
        initialBody="Carried note"
        onBodyChange={onBodyChange}
        onCancel={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(true)}
      />
    )
    const textarea = view.getByRole('textbox')
    expect(textarea instanceof HTMLTextAreaElement).toBe(true)
    if (textarea instanceof HTMLTextAreaElement) {
      expect(textarea.value).toBe('Carried note')
    }
    fireEvent.change(textarea, { target: { value: 'Updated note' } })
    expect(onBodyChange).toHaveBeenCalledWith('Updated note')
  })

  it('does not submit on Enter when IME composition is active', async () => {
    const onCancel = vi.fn()
    const onSubmit = vi.fn().mockResolvedValue(true)

    const view = render(
      <DiffCommentDraftCard lineNumber={10} onCancel={onCancel} onSubmit={onSubmit} />
    )

    const textarea = view.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'nihon' } })

    // IME composition
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('calls onCancel when clicking Cancel or pressing Escape', () => {
    const onCancel = vi.fn()
    const onSubmit = vi.fn().mockResolvedValue(true)

    const view = render(
      <DiffCommentDraftCard lineNumber={10} onCancel={onCancel} onSubmit={onSubmit} />
    )

    const cancelBtn = view.getByRole('button', { name: 'Cancel' })
    fireEvent.click(cancelBtn)
    expect(onCancel).toHaveBeenCalledTimes(1)

    const textarea = view.getByRole('textbox')
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('notifies onContentResize when textarea height changes', () => {
    const onContentResize = vi.fn()
    const onCancel = vi.fn()
    const onSubmit = vi.fn().mockResolvedValue(true)

    const view = render(
      <DiffCommentDraftCard
        lineNumber={10}
        onCancel={onCancel}
        onSubmit={onSubmit}
        onContentResize={onContentResize}
      />
    )

    const textarea = view.getByRole('textbox')
    // Called once on initial layout to settle view zone height
    expect(onContentResize).toHaveBeenCalledTimes(1)

    // Same height (60)
    fireEvent.change(textarea, { target: { value: 'line 1' } })
    expect(onContentResize).toHaveBeenCalledTimes(1)

    // Height increases
    scrollHeight = 120
    fireEvent.change(textarea, { target: { value: 'line 1\nline 2\nline 3' } })
    expect(onContentResize).toHaveBeenCalledTimes(2)
    expect(textarea.style.height).toBe('120px')
  })
})
