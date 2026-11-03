// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiffCommentCopyButton } from './DiffCommentCopyButton'

describe('DiffCommentCopyButton', () => {
  const writeClipboardText = vi.fn<(text: string) => Promise<void>>()

  beforeEach(() => {
    writeClipboardText.mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { writeClipboardText } }
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('writes the note text to the clipboard and confirms the copy', async () => {
    writeClipboardText.mockResolvedValue(undefined)
    const view = render(<DiffCommentCopyButton getText={() => 'File: a.ts\nLine: 3'} />)

    fireEvent.click(view.getByRole('button', { name: 'Copy note for agent' }))

    await waitFor(() => expect(view.getByRole('button', { name: 'Copied note' })).toBeTruthy())
    expect(writeClipboardText).toHaveBeenCalledWith('File: a.ts\nLine: 3')
  })

  it('stays retryable when the clipboard write fails', async () => {
    writeClipboardText.mockRejectedValue(new Error('not focused'))
    const view = render(<DiffCommentCopyButton getText={() => 'note'} />)

    fireEvent.click(view.getByRole('button', { name: 'Copy note for agent' }))

    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledTimes(1))
    expect(view.getByRole('button', { name: 'Copy note for agent' })).toBeTruthy()
  })
})
