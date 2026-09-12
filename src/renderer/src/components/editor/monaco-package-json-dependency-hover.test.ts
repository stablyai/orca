import { describe, expect, it, vi } from 'vitest'
import { ensurePackageJsonDependencyHoverProvider } from './monaco-package-json-dependency-hover'

function fakeMonaco(): {
  languages: { registerHoverProvider: ReturnType<typeof vi.fn> }
} {
  return {
    languages: {
      registerHoverProvider: vi.fn(() => ({ dispose: vi.fn() }))
    }
  }
}

describe('ensurePackageJsonDependencyHoverProvider', () => {
  it('registers exactly once across repeated calls with the same Monaco instance', () => {
    const monaco = fakeMonaco()

    ensurePackageJsonDependencyHoverProvider(monaco as never)
    ensurePackageJsonDependencyHoverProvider(monaco as never)
    ensurePackageJsonDependencyHoverProvider(monaco as never)

    expect(monaco.languages.registerHoverProvider).toHaveBeenCalledTimes(1)
    expect(monaco.languages.registerHoverProvider).toHaveBeenCalledWith(
      { language: 'json', pattern: '**/package.json' },
      expect.objectContaining({ provideHover: expect.any(Function) })
    )
  })

  it('disposes the old registration and registers again when the Monaco instance changes', () => {
    const monacoA = fakeMonaco()
    const monacoB = fakeMonaco()
    const disposeA = vi.fn()
    monacoA.languages.registerHoverProvider.mockReturnValueOnce({ dispose: disposeA })

    ensurePackageJsonDependencyHoverProvider(monacoA as never)
    ensurePackageJsonDependencyHoverProvider(monacoB as never)

    expect(disposeA).toHaveBeenCalledTimes(1)
    expect(monacoB.languages.registerHoverProvider).toHaveBeenCalledTimes(1)
  })
})
