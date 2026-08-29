import { describe, expect, it } from 'vitest'
import type { editor } from 'monaco-editor'
import { readMonacoLargeFileOptimizations } from './monaco-large-file-optimizations'
import { MONACO_HEAP_OPERATION_LIMIT_BYTES } from '../../../../shared/editor-file-read-limit'

function modelReporting(value: unknown): editor.ITextModel {
  return { isTooLargeForTokenization: () => value } as unknown as editor.ITextModel
}

describe('readMonacoLargeFileOptimizations', () => {
  it('reports applied only when the model itself says so', () => {
    expect(readMonacoLargeFileOptimizations(modelReporting(true))).toBe('applied')
    expect(readMonacoLargeFileOptimizations(modelReporting(false))).toBe('not-applied')
  })

  // The flag is @internal in monaco's public typings, so a version bump can
  // remove it. "We could not read it" must never be reported as "off" — that
  // would make the notice claim features are intact when they may not be.
  it('reports unknown when the flag cannot be read', () => {
    expect(readMonacoLargeFileOptimizations(null)).toBe('unknown')
    expect(readMonacoLargeFileOptimizations({} as editor.ITextModel)).toBe('unknown')
    expect(readMonacoLargeFileOptimizations(modelReporting('yes'))).toBe('unknown')
    expect(
      readMonacoLargeFileOptimizations({
        isTooLargeForTokenization: () => {
          throw new Error('disposed')
        }
      } as unknown as editor.ITextModel)
    ).toBe('unknown')
  })
})

// Why: the read ceiling is sized so an overridden open can never build a model
// the editor refuses whole-buffer reads on. That number lives in shared code
// where monaco cannot be imported, so pin it against monaco's own constant here
// — a version bump that moves the threshold has to move the ceiling with it.
describe('monaco heap-operation limit', () => {
  it('matches the byte ceiling shared code bounds reads with', async () => {
    const { TextModel } =
      (await import('monaco-editor/esm/vs/editor/common/model/textModel.js')) as unknown as {
        TextModel: { LARGE_FILE_HEAP_OPERATION_THRESHOLD: number }
      }
    expect(TextModel.LARGE_FILE_HEAP_OPERATION_THRESHOLD).toBe(MONACO_HEAP_OPERATION_LIMIT_BYTES)
  })
})
