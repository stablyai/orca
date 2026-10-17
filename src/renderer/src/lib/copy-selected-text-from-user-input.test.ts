// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copySelectedTextFromUserInput } from './copy-selected-text-from-user-input'

const performNativeSelectionAction = vi.fn<(action: 'copy' | 'select-all') => Promise<boolean>>()
const writeClipboardText = vi.fn<(text: string) => Promise<void>>()

describe('copySelectedTextFromUserInput dispatch acknowledgement', () => {
  beforeEach(() => {
    performNativeSelectionAction.mockReset().mockResolvedValue(true)
    writeClipboardText.mockReset().mockResolvedValue(undefined)
    vi.stubGlobal('api', {
      platform: { get: () => ({ platform: 'linux', displayServer: 'wayland' }) },
      ui: { performNativeSelectionAction }
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('keeps a dispatched native copy on the focused connection', async () => {
    const beforeNativeCopy = vi.fn()

    await copySelectedTextFromUserInput({
      text: 'selected text',
      writeClipboardText,
      beforeNativeCopy
    })

    expect(beforeNativeCopy.mock.invocationCallOrder[0]).toBeLessThan(
      performNativeSelectionAction.mock.invocationCallOrder[0]!
    )
    expect(performNativeSelectionAction).toHaveBeenCalledExactlyOnceWith('copy')
    expect(writeClipboardText).not.toHaveBeenCalled()
  })

  it.each(['declined', 'rejected'] as const)(
    'publishes the selected text through the existing writer when native dispatch is %s',
    async (failure) => {
      if (failure === 'declined') {
        performNativeSelectionAction.mockResolvedValue(false)
      } else {
        performNativeSelectionAction.mockRejectedValue(new Error('native IPC unavailable'))
      }

      await copySelectedTextFromUserInput({ text: '한글 😀', writeClipboardText })

      expect(performNativeSelectionAction).toHaveBeenCalledExactlyOnceWith('copy')
      expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith('한글 😀')
    }
  )

  it('waits for dispatch acknowledgement before deciding whether to use the writer', async () => {
    const dispatch = Promise.withResolvers<boolean>()
    performNativeSelectionAction.mockReturnValue(dispatch.promise)

    const copy = copySelectedTextFromUserInput({ text: 'selected text', writeClipboardText })
    expect(writeClipboardText).not.toHaveBeenCalled()

    dispatch.resolve(false)
    await copy

    expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith('selected text')
  })

  it('propagates a failed fallback writer instead of reporting a successful copy', async () => {
    performNativeSelectionAction.mockResolvedValue(false)
    writeClipboardText.mockRejectedValue(new Error('clipboard unchanged'))

    await expect(
      copySelectedTextFromUserInput({ text: 'selected text', writeClipboardText })
    ).rejects.toThrow('clipboard unchanged')
  })
})
