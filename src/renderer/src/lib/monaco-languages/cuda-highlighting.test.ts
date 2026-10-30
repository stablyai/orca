// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { monaco } from '../monaco-setup'
import { detectLanguage } from '../../../../shared/editor-language/editor-language-detect'

describe('CUDA highlighting through production Monaco setup', () => {
  it.each(['kernels/vector_add.cu', 'C:\\folder workspace\\VECTOR_TYPES.CUH'])(
    'recognizes and highlights %s',
    (filename) => {
      const language = detectLanguage(filename)
      expect(language).toBe('cuda-cpp')
      const source = '__global__ void k(double4 *p) { int i = threadIdx.x; } // done'
      const [line] = monaco.editor.tokenize(source, language)
      const typeAt = (word: string): string | undefined =>
        line.findLast((token) => token.offset <= source.indexOf(word))?.type
      for (const word of ['__global__', 'void', 'double4', 'threadIdx']) {
        expect(typeAt(word)).toMatch(/^keyword\..+\.cuda$/)
      }
      expect(typeAt('// done')).toBe('comment.cuda')
    }
  )
})
