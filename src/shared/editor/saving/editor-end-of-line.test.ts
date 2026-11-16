import { describe, expect, it } from 'vitest'
import { normalizeEditorEndOfLine, resolveNewModelLineEnding } from './editor-end-of-line'

describe('resolveNewModelLineEnding', () => {
  it('follows the owning host on auto', () => {
    const resolve = (hostPlatform: NodeJS.Platform | null) =>
      resolveNewModelLineEnding({ setting: 'auto', hostPlatform, language: 'plaintext' })
    expect(resolve('linux')).toBe('\n')
    expect(resolve('darwin')).toBe('\n')
    expect(resolve('win32')).toBe('\r\n')
    expect(resolve(null)).toBeNull()
  })

  it('lets an explicit choice override the host', () => {
    expect(
      resolveNewModelLineEnding({ setting: 'lf', hostPlatform: 'win32', language: 'typescript' })
    ).toBe('\n')
    expect(
      resolveNewModelLineEnding({ setting: 'crlf', hostPlatform: 'linux', language: 'typescript' })
    ).toBe('\r\n')
  })

  it('keeps the built-in LF default for shell scripts', () => {
    expect(
      resolveNewModelLineEnding({ setting: 'crlf', hostPlatform: 'win32', language: 'shellscript' })
    ).toBeNull()
  })

  it('treats missing or unknown settings as auto', () => {
    expect(normalizeEditorEndOfLine(undefined)).toBe('auto')
    expect(normalizeEditorEndOfLine('cr')).toBe('auto')
  })
})
