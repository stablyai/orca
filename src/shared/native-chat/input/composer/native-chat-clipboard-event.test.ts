import { afterEach, describe, expect, it, vi } from 'vitest'
import { textOnlyLabelsCopiedFiles } from './native-chat-clipboard-event'

describe('textOnlyLabelsCopiedFiles', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects large prompt text beside one copied file without splitting it', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const text = 'a\n'.repeat(8 * 1024 * 1024)
    expect(textOnlyLabelsCopiedFiles(text, ['/tmp/a'])).toBe(false)
    expect(split).not.toHaveBeenCalled()
  })

  it('still matches one label per copied file across line-break styles and trailing breaks', () => {
    expect(textOnlyLabelsCopiedFiles('a.txt\r\nb.txt\r\n', ['/tmp/b.txt', '/tmp/a.txt'])).toBe(true)
    expect(textOnlyLabelsCopiedFiles('a.txt\rb.txt', ['/tmp/a.txt', '/tmp/b.txt'])).toBe(true)
  })
})
