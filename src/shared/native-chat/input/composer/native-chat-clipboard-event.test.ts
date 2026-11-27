import { afterEach, describe, expect, it, vi } from 'vitest'
import { textOnlyLabelsCopiedFiles } from './native-chat-clipboard-event'

const manyFiles = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `/tmp/f${String(i)}`)

describe('textOnlyLabelsCopiedFiles', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects multi-line prompt text beside one copied file without splitting it', () => {
    const split = vi.spyOn(String.prototype, 'split')
    expect(textOnlyLabelsCopiedFiles('a\n'.repeat(8 * 1024 * 1024), ['/tmp/a'])).toBe(false)
    expect(split).not.toHaveBeenCalled()
  })

  it('rejects a 16 MiB single path-shaped line beside many copied files without splitting it', () => {
    const split = vi.spyOn(String.prototype, 'split')
    expect(textOnlyLabelsCopiedFiles('/a'.repeat(8 * 1024 * 1024), manyFiles(169))).toBe(false)
    expect(split).not.toHaveBeenCalled()
  })

  it('matches a Windows long-path file URL whose CJK segments encode to 9 chars per unit', () => {
    const name = 'b.txt'
    const segment = encodeURIComponent('你'.repeat(200))
    const url = `file:///C:/${`${segment}/`.repeat(60)}${name}`
    expect(url.length).toBeGreaterThan(100_000)
    expect(textOnlyLabelsCopiedFiles(url, [`C:\\x\\${name}`])).toBe(true)
  })

  it('matches one label per copied file across line-break styles and outer whitespace', () => {
    expect(textOnlyLabelsCopiedFiles('a.txt\r\nb.txt\r\n', ['/tmp/b.txt', '/tmp/a.txt'])).toBe(true)
    expect(textOnlyLabelsCopiedFiles('  a.txt\rb.txt\n\n', ['/tmp/a.txt', '/tmp/b.txt'])).toBe(true)
    expect(textOnlyLabelsCopiedFiles('/Users/me/a.txt', ['/tmp/a.txt'])).toBe(true)
  })

  it('keeps real prompt text beside copied files', () => {
    expect(textOnlyLabelsCopiedFiles('please review a.txt', ['/tmp/a.txt'])).toBe(false)
    expect(textOnlyLabelsCopiedFiles('a.txt\nb.txt', ['/tmp/a.txt'])).toBe(false)
  })
})
