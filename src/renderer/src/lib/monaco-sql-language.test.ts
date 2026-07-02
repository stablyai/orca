import { describe, expect, it, vi } from 'vitest'

const { monacoMock } = vi.hoisted(() => ({
  monacoMock: {
    languages: {
      getLanguages: vi.fn(() => [] as { id: string }[]),
      register: vi.fn(),
      setLanguageConfiguration: vi.fn(),
      setMonarchTokensProvider: vi.fn()
    }
  }
}))

vi.mock('@/lib/monaco-setup', () => ({ monaco: monacoMock }))
vi.mock('monaco-editor/esm/vs/basic-languages/sql/sql.js', () => ({
  conf: { comments: { lineComment: '--' } },
  language: { tokenizer: {} }
}))

import { ensureSqlLanguageRegistered } from './monaco-sql-language'

describe('ensureSqlLanguageRegistered', () => {
  it('registers SQL once (memoized) and wires config + Monarch tokens', async () => {
    await ensureSqlLanguageRegistered()
    await ensureSqlLanguageRegistered()

    // Memoized: the second call reuses the first registration promise.
    expect(monacoMock.languages.register).toHaveBeenCalledTimes(1)
    expect(monacoMock.languages.register).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sql' })
    )
    expect(monacoMock.languages.setLanguageConfiguration).toHaveBeenCalledWith(
      'sql',
      expect.anything()
    )
    expect(monacoMock.languages.setMonarchTokensProvider).toHaveBeenCalledWith(
      'sql',
      expect.anything()
    )
  })

  it('does not memoize a failed registration — a later call retries', async () => {
    vi.resetModules()
    let attempt = 0
    const localMonaco = {
      languages: {
        getLanguages: vi.fn(() => [] as { id: string }[]),
        register: vi.fn(),
        setLanguageConfiguration: vi.fn(),
        setMonarchTokensProvider: vi.fn(() => {
          attempt += 1
          if (attempt === 1) {
            throw new Error('registration failed')
          }
        })
      }
    }
    vi.doMock('@/lib/monaco-setup', () => ({ monaco: localMonaco }))
    vi.doMock('monaco-editor/esm/vs/basic-languages/sql/sql.js', () => ({
      conf: {},
      language: { tokenizer: {} }
    }))
    const mod = await import('./monaco-sql-language')

    await expect(mod.ensureSqlLanguageRegistered()).rejects.toThrow('registration failed')
    // The rejected promise must not be cached, so a later call can recover.
    await expect(mod.ensureSqlLanguageRegistered()).resolves.toBeUndefined()
    expect(attempt).toBe(2)
  })
})
