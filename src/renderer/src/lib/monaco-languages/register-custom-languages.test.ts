import { describe, expect, it, vi } from 'vitest'
import { registerCustomLanguages } from './register-custom-languages'
import { registerTextMateLanguage } from './textmate-language-registration'

vi.mock('./textmate-language-registration', () => ({ registerTextMateLanguage: vi.fn() }))
describe('registerCustomLanguages', () => {
  it('shares dependency grammars and reports missing dependencies clearly', async () => {
    const grammar = { scopeName: 'source.ts', patterns: [], repository: { $self: {}, $base: {} } }
    const reportError = vi.fn()
    registerCustomLanguages(
      {} as never,
      {
        languages: [
          { id: 'ExampleLang', scopeName: 'source.examplelang', extensions: ['.examplelang'] }
        ],
        grammars: { 'source.ts': grammar },
        diagnostics: ['Bad neighboring entry']
      },
      reportError
    )
    const registration = vi.mocked(registerTextMateLanguage).mock.lastCall![1]
    expect(registration.language).toEqual({ id: 'ExampleLang', extensions: ['.examplelang'] })
    expect(await registration.loadGrammar('source.ts')).toBe(grammar)
    await expect(registration.loadGrammar('source.missing')).rejects.toThrow(
      'Missing TextMate grammar source.missing'
    )
    registration.onError!(new Error('Invalid regex'))
    expect(reportError).toHaveBeenCalledWith('Bad neighboring entry')
    expect(reportError).toHaveBeenCalledWith('ExampleLang: Error: Invalid regex')
  })
})
