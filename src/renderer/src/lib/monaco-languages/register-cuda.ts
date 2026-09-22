import type * as Monaco from 'monaco-editor'
import {
  conf as cppLanguageConfiguration,
  language as cppMonarchLanguage
} from 'monaco-editor/esm/vs/basic-languages/cpp/cpp.js'

type MonacoModule = typeof Monaco

export const CUDA_LANGUAGE_ID = 'cuda-cpp'

const CUDA_KEYWORDS = [
  '__align__',
  '__constant__',
  '__device__',
  '__device_builtin__',
  '__forceinline__',
  '__global__',
  '__host__',
  '__launch_bounds__',
  '__managed__',
  '__noinline__',
  '__shared__',
  'blockDim',
  'blockIdx',
  'cudaError_t',
  'cudaStream_t',
  'dim3',
  'gridDim',
  'threadIdx',
  'warpSize'
] as const

const CUDA_VECTOR_TYPES = [
  'char1',
  'char2',
  'char3',
  'char4',
  'uchar1',
  'uchar2',
  'uchar3',
  'uchar4',
  'short1',
  'short2',
  'short3',
  'short4',
  'ushort1',
  'ushort2',
  'ushort3',
  'ushort4',
  'int1',
  'int2',
  'int3',
  'int4',
  'uint1',
  'uint2',
  'uint3',
  'uint4',
  'long1',
  'long2',
  'long3',
  'long4',
  'ulong1',
  'ulong2',
  'ulong3',
  'ulong4',
  'longlong1',
  'longlong2',
  'ulonglong1',
  'ulonglong2',
  'float1',
  'float2',
  'float3',
  'float4',
  'double1',
  'double2'
] as const

export const cudaMonarchLanguage: Monaco.languages.IMonarchLanguage = {
  ...cppMonarchLanguage,
  tokenPostfix: '.cuda',
  keywords: [...(cppMonarchLanguage.keywords ?? []), ...CUDA_KEYWORDS, ...CUDA_VECTOR_TYPES]
}

export function registerCudaLanguage(monaco: MonacoModule): void {
  const languageAlreadyRegistered = monaco.languages
    .getLanguages()
    .some((language) => language.id === CUDA_LANGUAGE_ID)
  if (languageAlreadyRegistered) {
    return
  }

  monaco.languages.register({
    id: CUDA_LANGUAGE_ID,
    extensions: ['.cu', '.cuh'],
    aliases: ['CUDA C/C++', 'CUDA']
  })
  monaco.languages.setLanguageConfiguration(CUDA_LANGUAGE_ID, cppLanguageConfiguration)
  monaco.languages.setMonarchTokensProvider(CUDA_LANGUAGE_ID, cudaMonarchLanguage)
}
