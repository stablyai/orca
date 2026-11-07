// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiffCommentCopyButton } from './DiffCommentCopyButton'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))

describe('DiffCommentCopyButton', () => {
  const writeClipboardText = vi.fn<(text: string) => Promise<void>>()

  beforeEach(() => {
    writeClipboardText.mockReset()
    toastError.mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { writeClipboardText } }
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('writes the note text to the clipboard and announces the copy', async () => {
    writeClipboardText.mockResolvedValue(undefined)
    const view = render(<DiffCommentCopyButton getText={() => 'File: a.ts\nLine: 3'} />)

    fireEvent.click(view.getByRole('button', { name: 'Copy note for agent' }))

    await waitFor(() => expect(view.getByRole('button', { name: 'Copied note' })).toBeTruthy())
    expect(writeClipboardText).toHaveBeenCalledWith('File: a.ts\nLine: 3')
    expect(view.getByRole('status').textContent).toBe('Copied note')
  })

  it('reports a failed clipboard write and stays retryable', async () => {
    writeClipboardText.mockRejectedValue(new Error('not focused'))
    const view = render(<DiffCommentCopyButton getText={() => 'note'} />)

    fireEvent.click(view.getByRole('button', { name: 'Copy note for agent' }))

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    expect(view.getByRole('button', { name: 'Copy note for agent' })).toBeTruthy()
    expect(view.getByRole('status').textContent).toBe('')
  })
})
