import { describe, expect, it, vi } from 'vitest'
import { registerShellMarkdownAliases } from './register-shell-markdown-aliases'

function createMonacoMock(aliases: string[] = ['Shell', 'sh']) {
  return {
    languages: {
      getLanguages: vi.fn(() => [{ id: 'shell', aliases }]),
      register: vi.fn()
    }
  }
}

describe('registerShellMarkdownAliases', () => {
  it('registers bash alongside the built-in shell aliases', () => {
    const monaco = createMonacoMock()

    registerShellMarkdownAliases(monaco)

    expect(monaco.languages.register).toHaveBeenCalledWith({
      id: 'shell',
      aliases: ['Shell', 'sh', 'bash']
    })
  })

  it('does not register the alias again when Monaco already exposes it', () => {
    const monaco = createMonacoMock(['Shell', 'sh', 'Bash'])

    registerShellMarkdownAliases(monaco)

    expect(monaco.languages.register).not.toHaveBeenCalled()
  })
})
