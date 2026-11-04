// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import * as Monaco from 'monaco-editor'
import { loadNodeOniguruma } from '../syntax-highlighting/oniguruma-test-harness'
import { registerZigLanguage } from './register-zig'

const grammarLoads = vi.hoisted(() => vi.fn())
vi.mock('shiki/langs/zig.mjs', async (importOriginal) => {
  grammarLoads()
  return importOriginal()
})
vi.mock('../syntax-highlighting/oniguruma', () => ({ loadOniguruma: loadNodeOniguruma }))

type Factory = Parameters<typeof Monaco.languages.registerTokensProviderFactory>[1]

describe('Zig lazy provider activation', () => {
  it('loads once on demand, preserves tokenizer state, and bounds long lines', async () => {
    const registered: Monaco.languages.ILanguageExtensionPoint[] = []
    let tokensFactory: Factory | undefined
    const languages = {
      ...Monaco.languages,
      getLanguages: () => registered,
      register: vi.fn((language: Monaco.languages.ILanguageExtensionPoint) => {
        registered.push(language)
        return { dispose: vi.fn() }
      }),
      setLanguageConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
      registerTokensProviderFactory: vi.fn((_id: string, factory: Factory) => {
        tokensFactory = factory
        return { dispose: vi.fn() }
      })
    }
    registerZigLanguage({ languages })
    expect(grammarLoads).not.toHaveBeenCalled()
    if (!tokensFactory) {
      throw new Error('Zig provider factory was not registered')
    }
    const factory: Factory = tokensFactory
    const pending = factory.create()
    expect(factory.create()).toBe(pending)
    const provider = await pending
    if (!provider || !('tokenize' in provider)) {
      throw new Error('Expected Zig line tokenizer')
    }
    expect(grammarLoads).toHaveBeenCalledTimes(1)
    registerZigLanguage({ languages })
    expect(languages.register).toHaveBeenCalledTimes(1)

    const opening = provider.tokenize('const text = \\\\fn // literal', provider.getInitialState())
    expect(opening.tokens.map((token) => token.scopes)).toContain('string.multiline.zig')
    const clone = opening.endState.clone()
    expect(clone.equals(opening.endState)).toBe(true)
    const after = provider.tokenize('pub fn after() void {}', clone)
    expect(after.tokens).toEqual(
      provider.tokenize('pub fn after() void {}', provider.getInitialState()).tokens
    )
    expect(after.tokens.map((token) => token.scopes)).toContain('keyword.zig')
    const edited = provider.tokenize('pub fn other() void {}', provider.getInitialState())
    expect(edited.endState.equals(after.endState)).toBe(true)

    const started = performance.now()
    const skipped = provider.tokenize('x'.repeat(1001), provider.getInitialState())
    const tail = provider.tokenize('pub fn after() void {}', skipped.endState)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(skipped.tokens).toEqual([{ startIndex: 0, scopes: 'source.zig' }])
    expect(tail.tokens).toEqual(skipped.tokens)
    expect(tail.endState.equals(skipped.endState)).toBe(true)
    expect(after.endState.equals(skipped.endState)).toBe(false)
  })
})
