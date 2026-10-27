// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { loadNodeOniguruma } from '../syntax-highlighting/oniguruma-test-harness'
import { monaco } from '../monaco-setup'
import { detectLanguage } from '../../../../shared/editor-language/editor-language-detect'

vi.mock('../syntax-highlighting/oniguruma', () => ({ loadOniguruma: loadNodeOniguruma }))

describe('Zig highlighting through production Monaco setup', () => {
  it.each(['main.zig', 'C:\\folder workspace\\MAIN.ZIG'])(
    'recognizes and highlights %s',
    async (filename) => {
      const language = detectLanguage(filename)
      expect(language).toBe('zig')
      const source =
        'pub fn main() void {\nconst answer: u32 = 42;\nconst text = "// literal"; // comment\n}'
      await monaco.editor.colorize(source, language, {})
      const tokens = monaco.editor.tokenize(source, language)
      expect(tokens[0].map((token) => token.type)).toContain('keyword.zig')
      expect(tokens[1].map((token) => token.type)).toEqual(
        expect.arrayContaining(['type.zig', 'number.zig'])
      )
      expect(tokens[2].map((token) => token.type)).toEqual(
        expect.arrayContaining(['string.quoted.double.zig', 'comment.line.double-slash.zig'])
      )
    }
  )

  it('highlights builtins, escapes, characters and multiline strings without leaking state', async () => {
    const source = [
      'const std = @import("std");',
      "const char: u8 = 'x';",
      'const text = "escaped \\n";',
      'const multiline = \\\\pub fn text // literal',
      '    \\\\second line',
      '    ;',
      'pub fn after() void {}'
    ].join('\n')
    await monaco.editor.colorize(source, 'zig', {})
    const tokens = monaco.editor.tokenize(source, 'zig')
    expect(tokens[0].map((token) => token.type)).toContain('type.zig')
    expect(tokens[1].map((token) => token.type)).toContain('string.quoted.single.zig')
    expect(tokens[2].map((token) => token.type)).toContain('string.escape.zig')
    expect(tokens[3].map((token) => token.type)).toContain('string.multiline.zig')
    expect(tokens[4].map((token) => token.type)).toContain('string.multiline.zig')
    expect(tokens[6].map((token) => token.type)).toContain('keyword.zig')
    expect(tokens[6].map((token) => token.type)).not.toContain('string.multiline.zig')
  })
})
