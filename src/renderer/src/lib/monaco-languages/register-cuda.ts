import type * as Monaco from 'monaco-editor'
import {
  conf as cppLanguageConfiguration,
  language as cppMonarchLanguage
} from 'monaco-editor/esm/vs/basic-languages/cpp/cpp.js'

type MonacoModule = typeof Monaco

// Same id and extensions as VS Code's built-in CUDA C++ language.
const CUDA_LANGUAGE_ID = 'cuda-cpp'

const CUDA_KEYWORDS = [
  '__global__',
  '__device__',
  '__host__',
  '__shared__',
  '__constant__',
  '__managed__',
  '__grid_constant__',
  '__forceinline__',
  '__noinline__',
  '__launch_bounds__',
  '__restrict__',
  '__align__',
  'threadIdx',
  'blockIdx',
  'blockDim',
  'gridDim',
  'warpSize',
  'dim3'
]

const CUDA_VECTOR_TYPES = [
  'char',
  'uchar',
  'short',
  'ushort',
  'int',
  'uint',
  'long',
  'ulong',
  'longlong',
  'ulonglong',
  'float',
  'double'
].flatMap((scalar) => [1, 2, 3, 4].map((width) => `${scalar}${width}`))

export function registerCudaLanguage(monaco: MonacoModule): void {
  if (monaco.languages.getLanguages().some((language) => language.id === CUDA_LANGUAGE_ID)) {
    return
  }
  monaco.languages.register({
    id: CUDA_LANGUAGE_ID,
    extensions: ['.cu', '.cuh'],
    aliases: ['CUDA C++', 'CUDA']
  })
  monaco.languages.setLanguageConfiguration(CUDA_LANGUAGE_ID, cppLanguageConfiguration)
  // CUDA is a C++ superset, so reuse Monaco's C++ grammar with CUDA identifiers as keywords.
  monaco.languages.setMonarchTokensProvider(CUDA_LANGUAGE_ID, {
    ...cppMonarchLanguage,
    tokenPostfix: '.cuda',
    keywords: [...cppMonarchLanguage.keywords, ...CUDA_KEYWORDS, ...CUDA_VECTOR_TYPES]
  })
}
