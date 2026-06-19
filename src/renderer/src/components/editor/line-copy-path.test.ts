import { describe, expect, it } from 'vitest'
import { formatPathLineReference } from './line-copy-path'

describe('formatPathLineReference', () => {
  it('uses the standard path:line format', () => {
    expect(formatPathLineReference('src/components/PdfViewer.tsx', 142)).toBe(
      'src/components/PdfViewer.tsx:142'
    )
  })
})
