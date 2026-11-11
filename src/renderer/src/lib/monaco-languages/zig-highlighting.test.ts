// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { loadNodeOniguruma } from '../syntax-highlighting/oniguruma-test-harness'
import { monaco } from '../editor/monaco/monaco-setup'

vi.mock('../syntax-highlighting/oniguruma', () => ({ loadOniguruma: loadNodeOniguruma }))

describe('Zig highlighting through production Monaco setup', () => {
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
