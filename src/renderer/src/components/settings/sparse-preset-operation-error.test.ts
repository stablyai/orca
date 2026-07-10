import { describe, expect, it } from 'vitest'
import { getSparsePresetOperationErrorMessage } from './sparse-preset-operation-error'

describe('getSparsePresetOperationErrorMessage', () => {
  it('uses the thrown error message when an async sparse preset action rejects', () => {
    expect(getSparsePresetOperationErrorMessage(new Error('disk failed'), 'fallback')).toBe(
      'disk failed'
    )
  })

  it('falls back for non-error rejections', () => {
    expect(getSparsePresetOperationErrorMessage('nope', 'Failed to save preset.')).toBe(
      'Failed to save preset.'
    )
  })
})
