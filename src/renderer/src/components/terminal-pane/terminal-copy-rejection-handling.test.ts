import { describe, expect, it, vi } from 'vitest'
import { runTerminalCopy, runTerminalIdentityCopy } from './terminal-copy-rejection-guards'

// Insecure-context clipboard rejection must neither escape as a crash breadcrumb nor show a false copy-success toast.

const REJECTION = new Error('Clipboard write is unavailable in this browser context')

describe('runTerminalCopy', () => {
  it('resolves and still refocuses the pane when the clipboard write rejects', async () => {
    const focus = vi.fn()
    const writeClipboardText = vi.fn().mockRejectedValue(REJECTION)

    await expect(
      runTerminalCopy({ selection: 'terminal text', writeClipboardText, focus })
    ).resolves.toBeUndefined()
    expect(writeClipboardText).toHaveBeenCalledWith('terminal text')
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('refocuses the pane after a successful copy', async () => {
    const focus = vi.fn()
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)

    await runTerminalCopy({ selection: 'terminal text', writeClipboardText, focus })

    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('skips the write but still refocuses when there is no selection', async () => {
    const focus = vi.fn()
    const writeClipboardText = vi.fn()

    await runTerminalCopy({ selection: '', writeClipboardText, focus })

    expect(writeClipboardText).not.toHaveBeenCalled()
    expect(focus).toHaveBeenCalledTimes(1)
  })
})

describe('runTerminalIdentityCopy', () => {
  it('reports failure instead of claiming success when the write rejects', async () => {
    const onSuccess = vi.fn()
    const onError = vi.fn()
    const focus = vi.fn()

    await expect(
      runTerminalIdentityCopy({
        text: 'tab:leaf',
        writeClipboardText: vi.fn().mockRejectedValue(REJECTION),
        onSuccess,
        onError,
        focus
      })
    ).resolves.toBeUndefined()

    expect(onSuccess).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('reports success and refocuses when the write lands', async () => {
    const onSuccess = vi.fn()
    const onError = vi.fn()
    const focus = vi.fn()

    await runTerminalIdentityCopy({
      text: 'tab:leaf',
      writeClipboardText: vi.fn().mockResolvedValue(undefined),
      onSuccess,
      onError,
      focus
    })

    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
    expect(focus).toHaveBeenCalledTimes(1)
  })
})
