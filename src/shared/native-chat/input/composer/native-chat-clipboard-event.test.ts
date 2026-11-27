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

  it('rejects many long path-shaped lines beside as many files without splitting them', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const text = Array.from({ length: 64 }, () => '/a'.repeat(131_071)).join('\n')
    expect(textOnlyLabelsCopiedFiles(text, manyFiles(64))).toBe(false)
    expect(split).not.toHaveBeenCalled()
  })

  it('rejects 16 MiB of whitespace beside one copied file without a per-character regex', () => {
    const regexTest = vi.spyOn(RegExp.prototype, 'test')
    expect(textOnlyLabelsCopiedFiles(' '.repeat(16 * 1024 * 1024), ['/tmp/a'])).toBe(false)
    expect(regexTest.mock.calls.length).toBeLessThanOrEqual(1)
  })

  it('matches a label line padded past the cap with whitespace', () => {
    const pad = ' '.repeat(300_000)
    const text = `b.txt\n${pad}a.txt${pad}\nc.txt`
    expect(textOnlyLabelsCopiedFiles(text, ['/tmp/a.txt', '/tmp/b.txt', '/tmp/c.txt'])).toBe(true)
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
