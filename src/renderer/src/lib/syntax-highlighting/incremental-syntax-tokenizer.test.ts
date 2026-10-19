import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createIncrementalSyntaxTokenizer,
  type SyntaxProgress
} from './incremental-syntax-tokenizer'
import {
  loadedSyntaxHighlighter,
  loadSyntaxLanguage,
  type SyntaxHighlighter,
  type SyntaxToken
} from './syntax-highlighter'

vi.mock('./oniguruma', async () => ({
  loadOniguruma: (await import('./oniguruma-test-harness')).loadNodeOniguruma
}))

const DOCUMENT = [
  'const greeting = `hello',
  '// still inside the template string',
  '${name}` /* a comment',
  'that spans lines */ + 1',
  'export default greeting',
  ''
].join('\n')

async function typescriptTokenizer(): Promise<SyntaxHighlighter> {
  await loadSyntaxLanguage('typescript')
  const highlighter = loadedSyntaxHighlighter('typescript')
  if (!highlighter) {
    throw new Error('typescript grammar did not load')
  }
  return highlighter
}

function colorsOf(lines: readonly (readonly SyntaxToken[])[]): unknown {
  return lines.map((line) => line.map((token) => [token.content, token.light, token.dark]))
}

function colors(progress: SyntaxProgress): unknown {
  return colorsOf(progress.lines.map((line) => line.tokens))
}

function text(progress: SyntaxProgress, code: string): string {
  return (
    progress.lines
      .map((line) => line.tokens.map((token) => token.content).join('') + line.ending)
      .join('') + code.slice(progress.highlightedLength)
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createIncrementalSyntaxTokenizer', () => {
  it('colors a streamed document exactly like a single full pass', async () => {
    const tokenizer = await typescriptTokenizer()
    const tokenize = createIncrementalSyntaxTokenizer(tokenizer)

    for (let length = 1; length <= DOCUMENT.length; length += 1) {
      const streamed = DOCUMENT.slice(0, length)
      const fullPass = tokenizer(streamed).lines
      // A full pass reports the empty line after a final newline; nothing renders for it.
      if (streamed.endsWith('\n')) {
        fullPass.pop()
      }
      expect(colors(tokenize(streamed, Infinity)), streamed).toEqual(colorsOf(fullPass))
    }
  })

  // Markdown ends a fence that is still being written with a newline; a raw stream does not.
  it.each(['', '\n'])(
    'keeps completed lines by identity while a document ending in %j grows',
    async (ending) => {
      const tokenize = createIncrementalSyntaxTokenizer(await typescriptTokenizer())
      const grown = `const a = 1\nconst b = 2${ending}`

      const before = tokenize(`const a = 1\nconst b${ending}`, Infinity)
      const after = tokenize(grown, Infinity)

      expect(after.lines[0]).toBe(before.lines[0])
      expect(after.lines[1]).not.toBe(before.lines[1])
      expect(text(after, grown)).toBe(grown)
    }
  )

  it('starts over when the document is replaced rather than extended', async () => {
    const tokenizer = await typescriptTokenizer()
    const tokenize = createIncrementalSyntaxTokenizer(tokenizer)

    tokenize('const a = `open\nstill open\n', Infinity)
    const replaced = 'let b = 2\nlet c = 3'

    expect(colors(tokenize(replaced, Infinity))).toEqual(
      colors(createIncrementalSyntaxTokenizer(tokenizer)(replaced, Infinity))
    )
  })

  it('stops when its time is spent and finishes over later calls', async () => {
    const tokenizer = await typescriptTokenizer()
    // Every batch takes one tick of a clock that otherwise stands still.
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const tokenize = createIncrementalSyntaxTokenizer((code, state) => {
      now += 1
      return tokenizer(code, state)
    })
    const code = 'const value = compute(1, "two", [3])\n'.repeat(200)

    let progress = tokenize(code, 1)
    expect(progress.highlightedLength).toBeGreaterThan(0)
    expect(progress.highlightedLength).toBeLessThan(code.length)
    expect(text(progress, code)).toBe(code)

    while (progress.highlightedLength < code.length) {
      progress = tokenize(code, 1)
    }
    expect(colors(progress)).toEqual(
      colors(createIncrementalSyntaxTokenizer(tokenizer)(code, Infinity))
    )
  })

  it('keeps every line after a skipped one plain, however the document streams', async () => {
    const tokenize = createIncrementalSyntaxTokenizer(await typescriptTokenizer())
    const code = `const a = 1\nconst long = "${'x'.repeat(2000)}"\nconst b = 2\nconst c = 3\n`

    let progress = tokenize(code.slice(0, code.indexOf('const b')), Infinity)
    progress = tokenize(code, Infinity)

    expect(progress.degraded).toBe(true)
    expect(colors(progress)).toEqual([
      expect.arrayContaining([['const', '#0000FF', '#569CD6']]),
      [[`const long = "${'x'.repeat(2000)}"`, undefined, undefined]],
      [['const b = 2', undefined, undefined]],
      [['const c = 3', undefined, undefined]]
    ])
    expect(text(progress, code)).toBe(code)
  })

  it.each(['a = 1\r\nb = 2\r\n', 'a = 1\r\nb = 2\nc = 3\r', 'a = 1\rb = 2\r\n\r\nc'])(
    'keeps the line endings of %j',
    async (code) => {
      const tokenize = createIncrementalSyntaxTokenizer(await typescriptTokenizer())

      for (let length = 1; length <= code.length; length += 1) {
        const streamed = code.slice(0, length)
        expect(text(tokenize(streamed, Infinity), streamed)).toBe(streamed)
      }
    }
  )
})
