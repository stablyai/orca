import { describe, expect, it, vi } from 'vitest'
import { loadNodeOniguruma } from '../syntax-highlighting/oniguruma-test-harness'
import { createMarkdownTokensProvider } from './markdown-textmate-tokens'

vi.mock('../syntax-highlighting/oniguruma', () => ({ loadOniguruma: loadNodeOniguruma }))

describe('markdown tokenization', () => {
  it('colors frontmatter as YAML on first paint, then returns to markdown', async () => {
    const provider = await createMarkdownTokensProvider({
      editor: { defineTheme: vi.fn() },
      languages: { setTokensProvider: vi.fn() }
    })
    let state = provider.getInitialState()
    const tokens = ['---', 'name: "Orca"', 'enabled: true # flag', '---', '# Heading'].map(
      (line) => {
        const result = provider.tokenize(line, state)
        state = result.endState
        return result.tokens
      }
    )

    expect(tokens[1]).toContainEqual({ startIndex: 0, scopes: 'md.entity.name.tag.yaml' })
    expect(tokens[1]).toContainEqual({ startIndex: 6, scopes: 'md.string.quoted.double.yaml' })
    expect(tokens[2]).toContainEqual({ startIndex: 9, scopes: 'md.constant.language.boolean.yaml' })
    expect(tokens[2]).toContainEqual({ startIndex: 14, scopes: 'md.comment.line.number-sign.yaml' })
    expect(tokens[4]).toContainEqual({ startIndex: 2, scopes: 'md.entity.name.section.markdown' })
  })
})
