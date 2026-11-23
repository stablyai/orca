// @vitest-environment happy-dom
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { language as stockSwiftLanguage } from 'monaco-editor/esm/vs/basic-languages/swift/swift.js'
import { expect, it, vi } from 'vitest'
import { registerSwiftLanguage } from './register-swift'

const SOURCE = String.raw`import Foundation
enum Markdown {
    static let codeFence = try! Regex(#"["${'`'}]{3}"#)
    static let lineBreak = try! Regex(#"["${'`'}]\n"#)
    static func escape(_ text: String?) -> String {
let a = ##"ends "# not here"## + 1
let b = #"n: \#(count) \(raw)"#
let c = #"say \#"hi\#""#
let d = #"""
  has """ and "# inside
  """#
let e = #""" x "# + 1
let f = #"""# + 1
let g = #""
let h = #"
let i = 1
let j = #################"before "################ after"#################
let k = 1`

it('keeps Swift tokens intact after raw strings that contain quotes', async () => {
  monaco.languages.register({ id: 'swift' })
  // Mirrors Monaco's own Swift contribution, which registers before Orca's setup runs.
  monaco.languages.registerTokensProviderFactory('swift', { create: () => stockSwiftLanguage })
  registerSwiftLanguage(monaco)

  const lines = SOURCE.split('\n')
  let tokens: monaco.Token[][] = []
  const typeAt = (lineNumber: number, needle: string): string | undefined => {
    const offset = lines[lineNumber - 1].indexOf(needle)
    return tokens[lineNumber - 1].findLast((token) => token.offset <= offset)?.type
  }
  await vi.waitFor(() => {
    tokens = monaco.editor.tokenize(SOURCE, 'swift')
    expect(typeAt(1, 'import')).toBe('keyword.swift')
  })

  expect(typeAt(5, 'func')).toBe('keyword.swift')
  expect(typeAt(6, 'not here')).toBe('string.swift')
  expect(typeAt(6, '+')).toBe('operator.swift')
  expect(typeAt(7, 'count')).toBe('identifier.swift')
  expect(typeAt(7, 'raw')).toBe('string.swift')
  expect(typeAt(8, 'hi')).toBe('string.swift')
  expect(typeAt(9, 'let')).toBe('keyword.swift')
  expect(typeAt(10, 'inside')).toBe('string.swift')
  expect(typeAt(12, 'x')).toBe('string.swift')
  expect(typeAt(12, '+')).toBe('operator.swift')
  expect(typeAt(13, '+')).toBe('operator.swift')
  expect(typeAt(14, 'let')).toBe('keyword.swift')
  expect(typeAt(15, 'let')).toBe('keyword.swift')
  expect(typeAt(16, 'let')).toBe('keyword.swift')
  // Swift's extended delimiters take any count of one or more signs; a 17-sign opener whose literal
  // holds 16 signs closed on the wrong quote and turned the next line into string (#47295).
  expect(typeAt(17, 'after')).toBe('string.swift')
  expect(typeAt(18, 'let')).toBe('keyword.swift')
})
