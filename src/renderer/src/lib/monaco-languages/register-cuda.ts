import type * as Monaco from 'monaco-editor'
import type { IRawGrammar } from 'vscode-textmate'
import { registerTextMateLanguage } from './textmate-language-registration'

type MonacoModule = typeof Monaco

export const CUDA_LANGUAGE_ID = 'cuda'
export const CUDA_TEXTMATE_SCOPE = 'source.cuda-cpp'
export const CUDA_CPP_FALLBACK_SCOPE = 'source.cpp'

export const cudaLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: {
    lineComment: '//',
    blockComment: ['/*', '*/']
  },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')']
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" }
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" }
  ]
}

/** Resolves the vendored CUDA grammar, and its `source.cpp` fallback, for {@link registerCudaLanguage}. */
export async function loadCudaTextMateGrammar(scopeName: string): Promise<IRawGrammar | null> {
  if (scopeName === CUDA_TEXTMATE_SCOPE) {
    // Why: CUDA highlighting uses the kriegalex/vscode-cuda TextMate grammar
    // (MIT; see textmate-grammars/cuda-LICENSE.txt).
    const grammarModule = await import('./textmate-grammars/cuda.tmLanguage.json')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the imported JSON is the vendored CUDA grammar, whose shape matches IRawGrammar.
    return grammarModule.default as unknown as IRawGrammar
  }

  if (scopeName === CUDA_CPP_FALLBACK_SCOPE) {
    // Why: the CUDA grammar's own patterns only cover CUDA-specific syntax and
    // block punctuation; everything else (keywords, comments, strings,
    // preprocessor) it delegates via `"include": "source.cpp"`. Vendor the
    // matching C++ grammar (jeff-hykin/better-cpp-syntax; MIT; see
    // textmate-grammars/cpp-LICENSE.txt) so that include actually resolves.
    const grammarModule = await import('./textmate-grammars/cpp.tmLanguage.json')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the imported JSON is the vendored C++ grammar, whose shape matches IRawGrammar.
    return grammarModule.default as unknown as IRawGrammar
  }

  return null
}

/** Registers `.cu`/`.cuh` as the `cuda` Monaco language, backed by the vendored TextMate grammar. */
export function registerCudaLanguage(monaco: MonacoModule): void {
  registerTextMateLanguage(monaco, {
    language: {
      id: CUDA_LANGUAGE_ID,
      extensions: ['.cu', '.cuh'],
      aliases: ['CUDA C++', 'cuda']
    },
    configuration: cudaLanguageConfiguration,
    scopeName: CUDA_TEXTMATE_SCOPE,
    loadGrammar: loadCudaTextMateGrammar
  })
}

// Note: the vendored C++ grammar references the external scope
// source.cpp.embedded.macro, which nothing registers, so #define macro bodies
// only get the coarse meta.preprocessor.macro.cpp scope with no internal
// tokenization. Known limitation of the vendored grammar, not fixable here.
