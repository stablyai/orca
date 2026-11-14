import { describe, expect, it } from 'vitest'
import { MarkdownPreviewDocumentEngine } from './markdown-preview-document-engine'

describe('large preview searchable text ownership', () => {
  it('cancels indexing, retains completed text, and clears it on document replacement', async () => {
    const engine = new MarkdownPreviewDocumentEngine()
    engine.load('needle\n\n'.repeat(100))
    const pending = engine.search('needle')
    engine.cancelSearch()
    expect(await pending).toBeNull()
    expect((await engine.search('needle'))?.matches).toHaveLength(100)
    engine.load('needle replacement')
    expect((await engine.search('replacement'))?.matches).toHaveLength(1)
  })
})
