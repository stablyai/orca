import { afterEach, describe, expect, it, vi } from 'vitest'
import { textOnlyLabelsCopiedFiles } from './native-chat-clipboard-event'

describe('textOnlyLabelsCopiedFiles', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects multi-line prompt text beside one copied file without splitting it', () => {
    const split = vi.spyOn(String.prototype, 'split')
    // Under the length bound, so the line count is what rejects it.
    const text = 'a\n'.repeat(40_000)
    expect(textOnlyLabelsCopiedFiles(text, ['/tmp/a'])).toBe(false)
    expect(split).not.toHaveBeenCalled()
  })

  it('rejects one huge path-shaped line beside one copied file without splitting it', () => {
    const split = vi.spyOn(String.prototype, 'split')
    expect(textOnlyLabelsCopiedFiles('/a'.repeat(8 * 1024 * 1024), ['/tmp/a'])).toBe(false)
    expect(split).not.toHaveBeenCalled()
  })

  it('still matches a Windows long-path file URL as one label', () => {
    const name = 'b'.repeat(200)
    const longPath = `C:/${'%E4%BD%A0/'.repeat(3000)}${name}`
    expect(textOnlyLabelsCopiedFiles(`file:///${longPath}`, [`C:\\x\\${name}`])).toBe(true)
  })

  it('still matches one label per copied file across line-break styles and trailing breaks', () => {
    expect(textOnlyLabelsCopiedFiles('a.txt\r\nb.txt\r\n', ['/tmp/b.txt', '/tmp/a.txt'])).toBe(true)
    expect(textOnlyLabelsCopiedFiles('a.txt\rb.txt', ['/tmp/a.txt', '/tmp/b.txt'])).toBe(true)
  })
})
