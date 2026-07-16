import { describe, expect, it, vi } from 'vitest'
import { decodeBase64Document } from './office-document-parse'
import { resolvePresentationPreviewBuffer } from './office-presentation-preview'

describe('resolvePresentationPreviewBuffer', () => {
  it('uses the native flattened deck when PowerPoint renders one', async () => {
    const original = decodeBase64Document(btoa('original'))
    const renderNative = vi.fn(async () => ({
      status: 'rendered' as const,
      contentBase64: btoa('flattened')
    }))

    const result = await resolvePresentationPreviewBuffer(
      btoa('original'),
      original,
      'preview-1',
      renderNative
    )

    expect(renderNative).toHaveBeenCalledWith({
      contentBase64: btoa('original'),
      requestToken: 'preview-1'
    })
    expect(new TextDecoder().decode(result)).toBe('flattened')
  })

  it.each([
    ['is unavailable', vi.fn(async () => ({ status: 'unavailable' as const, reason: 'missing' }))],
    [
      'throws',
      vi.fn(async () => {
        throw new Error('IPC unavailable')
      })
    ]
  ])('keeps the browser renderer when native rendering %s', async (_label, renderNative) => {
    const original = decodeBase64Document(btoa('original'))

    await expect(
      resolvePresentationPreviewBuffer(btoa('original'), original, 'preview-1', renderNative)
    ).resolves.toBe(original)
  })
})
