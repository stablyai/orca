// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution.js'
import { language as stockPythonLanguage } from 'monaco-editor/esm/vs/basic-languages/python/python.js'
import { tokenizeMonarchDocument, tokenTypeAt } from './monarch-tokenizer-test-harness'
import { patchPythonTripleQuotedFStrings, registerPythonLanguage } from './register-python'

const pythonLanguage = patchPythonTripleQuotedFStrings(stockPythonLanguage)

describe('Python multiline f-string tokenization', () => {
  it('uses the corrected lazy grammar through Monaco public colorization', async () => {
    const factory = vi.spyOn(monaco.languages, 'registerTokensProviderFactory')
    registerPythonLanguage(monaco)
    const registration = factory.mock.results[0]?.value
    try {
      const source = 'value = f"""\nbody\n"""\nclass Runner:'
      await monaco.editor.colorize(source, 'python', {})
      expect(monaco.editor.tokenize(source, 'python')[3][0].type).toBe('keyword.python')
      expect(factory.mock.calls[0]?.[0]).toBe('python')
    } finally {
      registration?.dispose()
      factory.mockRestore()
    }
  })

  it('leaves the shared stock grammar unchanged across repeated configuration', () => {
    const twice = patchPythonTripleQuotedFStrings(stockPythonLanguage)
    const source = 'value = f"""\nbody\n"""\nclass Runner:'
    const stock = tokenizeMonarchDocument('python', stockPythonLanguage, source)
    const repeated = tokenizeMonarchDocument('python', twice, source)
    expect(tokenTypeAt(stock[3], 0)).toBe('string')
    expect(tokenTypeAt(repeated[3], 0)).toBe('keyword')
    expect(twice.tokenizer.strings).toHaveLength(pythonLanguage.tokenizer.strings.length)
  })

  for (const delimiter of ['"""', "'''"] as const) {
    it(`keeps f${delimiter} open until its closing delimiter`, () => {
      const lines = tokenizeMonarchDocument(
        'python',
        pythonLanguage,
        [
          `x = f${delimiter}`,
          'SELECT 1',
          delimiter,
          '',
          'with open("f.txt") as dag:',
          '    pass'
        ].join('\n')
      )
      expect(tokenTypeAt(lines[1], 0)).toBe('string')
      expect(tokenTypeAt(lines[4], 0)).toBe('keyword')
      expect(tokenTypeAt(lines[5], 4)).toBe('keyword')
    })

    it(`keeps escaped quotes, braces, and line continuations inside f${delimiter}`, () => {
      const quote = delimiter[0]
      const lines = tokenizeMonarchDocument(
        'python',
        pythonLanguage,
        [
          `x = f${delimiter}`,
          `literal \\${quote}${quote}${quote} {{escaped}} {table!r:>10} \\`,
          'FROM table',
          delimiter,
          'class Runner:'
        ].join('\n')
      )
      expect(tokenTypeAt(lines[1], lines[1].text.length - 1)).toBe('string')
      expect(tokenTypeAt(lines[2], 0)).toBe('string')
      expect(tokenTypeAt(lines[4], 0)).toBe('keyword')
    })

    it(`returns to Python code after an inline f${delimiter} terminator`, () => {
      const lines = tokenizeMonarchDocument(
        'python',
        pythonLanguage,
        [`value = f${delimiter}hello {name}${delimiter}; pass`, 'class Runner:'].join('\n')
      )
      expect(tokenTypeAt(lines[0], lines[0].text.indexOf('pass'))).toBe('keyword')
      expect(tokenTypeAt(lines[1], 0)).toBe('keyword')
    })
  }

  it('preserves single-line f-strings and ordinary multiline strings', () => {
    for (const source of [
      'value = f"hello {name!r}"\nclass Runner:',
      "value = f'hello {name}'\nclass Runner:",
      'value = """\nbody\n"""\nclass Runner:',
      "value = '''\nbody\n'''\nclass Runner:",
      'value = F"""\nbody\n"""\nclass Runner:',
      'value = rf"""\nbody\n"""\nclass Runner:'
    ]) {
      const lines = tokenizeMonarchDocument('python', pythonLanguage, source)
      const last = lines.at(-1)
      if (!last) {
        throw new Error('Python control produced no lines')
      }
      expect(tokenTypeAt(last, 0)).toBe('keyword')
    }
  })
})
