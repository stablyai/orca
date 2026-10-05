import { describe, expect, it } from 'vitest'
import { normalizeRepoLanguageServerSettings } from './repo-language-server-settings'
import { enabledServerForLanguage } from './language-server-catalog'

describe('normalizeRepoLanguageServerSettings', () => {
  it('returns undefined for non-objects and empty settings', () => {
    expect(normalizeRepoLanguageServerSettings(null)).toBeUndefined()
    expect(normalizeRepoLanguageServerSettings('ruby')).toBeUndefined()
    expect(normalizeRepoLanguageServerSettings({})).toBeUndefined()
  })

  it('keeps known boolean flags and drops unknown ids', () => {
    expect(
      normalizeRepoLanguageServerSettings({
        enabled: { typescript: true, gopls: true, 'ruby-lsp': 'yes' }
      })
    ).toEqual({ enabled: { typescript: true } })
  })

  it('allows only one enabled server per language, ruby-lsp first', () => {
    expect(
      normalizeRepoLanguageServerSettings({ enabled: { 'ruby-lsp': true, solargraph: true } })
    ).toEqual({ enabled: { 'ruby-lsp': true, solargraph: false } })
  })

  it('keeps valid argv for external servers only', () => {
    expect(
      normalizeRepoLanguageServerSettings({
        command: {
          'ruby-lsp': ['bundle', 'exec', 'ruby-lsp'],
          typescript: ['node', 'x.js'],
          solargraph: ['bad\0arg']
        }
      })
    ).toEqual({ command: { 'ruby-lsp': ['bundle', 'exec', 'ruby-lsp'] } })
  })

  it('rejects empty, oversized and non-string argv', () => {
    expect(normalizeRepoLanguageServerSettings({ command: { 'ruby-lsp': [] } })).toBeUndefined()
    expect(normalizeRepoLanguageServerSettings({ command: { 'ruby-lsp': [1] } })).toBeUndefined()
    expect(
      normalizeRepoLanguageServerSettings({ command: { 'ruby-lsp': ['x'.repeat(1025)] } })
    ).toBeUndefined()
  })
})

describe('enabledServerForLanguage', () => {
  it('maps a Monaco language id to the enabled server', () => {
    const settings = { enabled: { typescript: true, solargraph: true } }
    expect(enabledServerForLanguage(settings, 'javascript')).toBe('typescript')
    expect(enabledServerForLanguage(settings, 'ruby')).toBe('solargraph')
    expect(enabledServerForLanguage(settings, 'python')).toBeNull()
    expect(enabledServerForLanguage(undefined, 'ruby')).toBeNull()
  })
})
