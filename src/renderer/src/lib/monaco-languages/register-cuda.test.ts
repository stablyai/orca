import { describe, expect, it, vi } from 'vitest'
import {
  CUDA_CPP_FALLBACK_SCOPE,
  CUDA_LANGUAGE_ID,
  CUDA_TEXTMATE_SCOPE,
  cudaLanguageConfiguration,
  loadCudaTextMateGrammar,
  registerCudaLanguage
} from './register-cuda'

function createMonacoMock() {
  return {
    languages: {
      getLanguages: vi.fn(() => []),
      register: vi.fn(),
      setLanguageConfiguration: vi.fn(),
      registerTokensProviderFactory: vi.fn()
    }
  }
}

describe('registerCudaLanguage', () => {
  it('maps CUDA extensions to the reusable TextMate-backed language registration', () => {
    const monaco = createMonacoMock()

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock only implements the languages methods registerCudaLanguage calls.
    registerCudaLanguage(monaco as never)

    expect(monaco.languages.register).toHaveBeenCalledWith({
      id: CUDA_LANGUAGE_ID,
      extensions: ['.cu', '.cuh'],
      aliases: ['CUDA C++', 'cuda']
    })
    expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledWith(
      CUDA_LANGUAGE_ID,
      cudaLanguageConfiguration
    )
    expect(monaco.languages.registerTokensProviderFactory).toHaveBeenCalledWith(
      CUDA_LANGUAGE_ID,
      expect.objectContaining({ create: expect.any(Function) })
    )
  })
})

describe('loadCudaTextMateGrammar', () => {
  it('loads the vendored CUDA TextMate grammar for the CUDA scope', async () => {
    const grammar = await loadCudaTextMateGrammar(CUDA_TEXTMATE_SCOPE)

    expect(grammar).toMatchObject({
      name: 'CUDA C++',
      scopeName: CUDA_TEXTMATE_SCOPE
    })
  })

  it('loads the vendored C++ grammar for the source.cpp fallback scope', async () => {
    const grammar = await loadCudaTextMateGrammar(CUDA_CPP_FALLBACK_SCOPE)

    expect(grammar).toMatchObject({
      name: 'C++',
      scopeName: CUDA_CPP_FALLBACK_SCOPE
    })
  })

  it('ignores unrelated TextMate scopes', async () => {
    await expect(loadCudaTextMateGrammar('source.python')).resolves.toBeNull()
  })
})
