import { describe, expect, it, vi } from 'vitest'
import {
  BASH_MARKDOWN_LANGUAGE_ALIAS,
  registerShellMarkdownAliases,
  SHELL_LANGUAGE_ID
} from './register-shell-markdown-aliases'

function createMonacoMock(aliases: string[] = ['Shell', 'sh']) {
  return {
    languages: {
      getLanguages: vi.fn(() => [{ id: SHELL_LANGUAGE_ID, aliases }]),
      register: vi.fn()
    }
  }
}

describe('registerShellMarkdownAliases', () => {
  it('adds bash to Monaco shell language lookup without replacing the language ID', () => {
    const monaco = createMonacoMock()

    registerShellMarkdownAliases(monaco)

    expect(monaco.languages.register).toHaveBeenCalledWith({
      id: SHELL_LANGUAGE_ID,
      aliases: ['Shell', 'sh', BASH_MARKDOWN_LANGUAGE_ALIAS]
    })
  })

  it('does not register the alias again when Monaco already exposes it', () => {
    const monaco = createMonacoMock(['Shell', 'sh', 'Bash'])

    registerShellMarkdownAliases(monaco)

    expect(monaco.languages.register).not.toHaveBeenCalled()
  })
})
