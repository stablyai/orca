import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetModules()
})
describe('custom language snapshot startup', () => {
  it('shares one request and installs associations before startup resolves', async () => {
    const getCustomLanguages = vi.fn(async () => ({
      languages: [
        { id: 'ExampleLang', scopeName: 'source.examplelang', extensions: ['.examplelang'] }
      ],
      grammars: {},
      diagnostics: []
    }))
    vi.stubGlobal('window', { api: { settings: { getCustomLanguages } } })
    const { loadCustomLanguageSnapshot } = await import('./custom-language-snapshot')
    const { detectLanguage } = await import('./language-detect')
    expect(loadCustomLanguageSnapshot()).toBe(loadCustomLanguageSnapshot())
    await loadCustomLanguageSnapshot()
    expect(getCustomLanguages).toHaveBeenCalledTimes(1)
    expect(detectLanguage('/remote/repo/file.examplelang')).toBe('ExampleLang')
  })

  it('uses built-in highlighting on web clients without local grammar access', async () => {
    vi.stubGlobal('window', { api: { settings: {} } })
    const { loadCustomLanguageSnapshot } = await import('./custom-language-snapshot')
    expect(await loadCustomLanguageSnapshot()).toEqual({
      languages: [],
      grammars: {},
      diagnostics: []
    })
  })

  it('does not block startup when the local bridge fails', async () => {
    vi.stubGlobal('window', {
      api: {
        settings: {
          getCustomLanguages: async () => {
            throw new Error('unavailable')
          }
        }
      }
    })
    const { loadCustomLanguageSnapshot } = await import('./custom-language-snapshot')
    const snapshot = await loadCustomLanguageSnapshot()
    expect(snapshot.languages).toEqual([])
    expect(snapshot.diagnostics[0]).toContain('unavailable')
  })
  it('unblocks startup after a stalled read without installing late associations', async () => {
    vi.useFakeTimers()
    let finish!: (value: unknown) => void
    const request = new Promise((resolve) => {
      finish = resolve
    })
    vi.stubGlobal('window', { api: { settings: { getCustomLanguages: () => request } } })
    const { loadCustomLanguageSnapshot } = await import('./custom-language-snapshot')
    const { detectLanguage } = await import('./language-detect')
    const pending = loadCustomLanguageSnapshot()
    await vi.advanceTimersByTimeAsync(3000)
    const snapshot = await pending
    expect(snapshot.languages).toEqual([])
    expect(snapshot.diagnostics[0]).toContain('timed out')
    finish({
      languages: [{ id: 'example', scopeName: 'source.example', extensions: ['.example'] }],
      grammars: {},
      diagnostics: []
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(detectLanguage('file.example')).toBe('plaintext')
  })
})
