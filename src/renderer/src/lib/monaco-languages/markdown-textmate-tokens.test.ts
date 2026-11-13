import type * as Monaco from 'monaco-editor'
import { describe, expect, it, vi } from 'vitest'
import { loadNodeOniguruma } from '../syntax-highlighting/oniguruma-test-harness'
import { createMarkdownTokensProvider } from './markdown-textmate-tokens'

vi.mock('../syntax-highlighting/oniguruma', () => ({ loadOniguruma: loadNodeOniguruma }))

async function tokenize(lines: string[]): Promise<Monaco.languages.IToken[][]> {
  const provider = await createMarkdownTokensProvider({
    editor: { defineTheme: vi.fn() },
    languages: { setTokensProvider: vi.fn() }
  })
  let state = provider.getInitialState()
  return lines.map((line) => {
    const result = provider.tokenize(line, state)
    state = result.endState
    return result.tokens
  })
}

describe('Markdown frontmatter tokenization', () => {
  it('highlights YAML immediately and resumes Markdown after the closing delimiter', async () => {
    const tokens = await tokenize([
      '---',
      'name: "Orca"',
      'enabled: true',
      'count: 42 # items',
      '---',
      '# Heading'
    ])

    expect(tokens[1]).toContainEqual({ startIndex: 0, scopes: 'md.entity.name.tag.yaml' })
    expect(tokens[1]).toContainEqual({ startIndex: 7, scopes: 'md.string.quoted.double.yaml' })
    expect(tokens[2]).toContainEqual({ startIndex: 9, scopes: 'md.constant.language.boolean.yaml' })
    expect(tokens[3]).toContainEqual({ startIndex: 7, scopes: 'md.constant.numeric.integer.yaml' })
    expect(tokens[3]).toContainEqual({ startIndex: 10, scopes: 'md.comment.line.number-sign.yaml' })
    expect(tokens[5]).toContainEqual({ startIndex: 2, scopes: 'md.entity.name.section.markdown' })
  })

  it('keeps unfinished frontmatter in YAML while editing, including nested and block values', async () => {
    const tokens = await tokenize([
      '---',
      'options:',
      '  - true',
      'description: |',
      '  # YAML text, not a Markdown heading',
      'count: 42'
    ])

    expect(tokens[2]).toContainEqual({ startIndex: 4, scopes: 'md.constant.language.boolean.yaml' })
    expect(tokens[4]).toContainEqual({ startIndex: 2, scopes: 'md.string.unquoted.block.yaml' })
    expect(tokens[5]).toContainEqual({ startIndex: 7, scopes: 'md.constant.numeric.integer.yaml' })
  })

  it('leaves body separators and ordinary code fences as Markdown', async () => {
    const tokens = await tokenize([
      '# Heading',
      '',
      '---',
      'count: 42',
      '',
      '```text',
      '---',
      'enabled: true',
      '```',
      '# After fence'
    ])

    expect(tokens[2]).toContainEqual({ startIndex: 0, scopes: 'md.meta.separator.markdown' })
    expect(tokens[3]).toEqual([{ startIndex: 0, scopes: 'md.text.html.markdown' }])
    expect(tokens[7]).toEqual([{ startIndex: 0, scopes: 'md.text.html.markdown' }])
    expect(tokens[9]).toContainEqual({ startIndex: 2, scopes: 'md.entity.name.section.markdown' })
  })
})
