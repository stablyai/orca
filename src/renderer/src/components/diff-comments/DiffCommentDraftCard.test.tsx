// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiffCommentDraftCard } from './DiffCommentDraftCard'

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
    expect(view.getByPlaceholderText('Add note for the AI')).toBeDefined()
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
