import type { OnMount } from '@monaco-editor/react'
import { describe, expect, it, vi } from 'vitest'
import { ensurePackageJsonDependencyHoverProvider } from './monaco-package-json-dependency-hover'

type FakeMonaco = { languages: { registerHoverProvider: ReturnType<typeof vi.fn> } }

function fakeMonaco(): FakeMonaco {
  return {
    languages: {
      registerHoverProvider: vi.fn(() => ({ dispose: vi.fn() }))
    }
  }
}

function asMonacoApi(fake: FakeMonaco): Parameters<OnMount>[1] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the Monaco namespace cannot be constructed in a unit test, and `ensurePackageJsonDependencyHoverProvider` reads only `languages.registerHoverProvider`, which this fake implements; reaching any other member would throw here rather than pass silently.
  return fake as never
}

describe('ensurePackageJsonDependencyHoverProvider', () => {
  it('registers exactly once across repeated calls with the same Monaco instance', () => {
    const monaco = fakeMonaco()

    ensurePackageJsonDependencyHoverProvider(asMonacoApi(monaco))
    ensurePackageJsonDependencyHoverProvider(asMonacoApi(monaco))
    ensurePackageJsonDependencyHoverProvider(asMonacoApi(monaco))

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

    ensurePackageJsonDependencyHoverProvider(asMonacoApi(monacoA))
    ensurePackageJsonDependencyHoverProvider(asMonacoApi(monacoB))

    expect(disposeA).toHaveBeenCalledTimes(1)
    expect(monacoB.languages.registerHoverProvider).toHaveBeenCalledTimes(1)
  })
})
