import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownPreviewDocumentEngine } from './markdown-preview-document-engine'
import * as documentTree from './markdown-preview-document-tree'

afterEach(() => vi.restoreAllMocks())

describe('large preview searchable text ownership', () => {
  it('cancels indexing, retains completed text, and clears it on document replacement', async () => {
    const render = vi.spyOn(documentTree, 'renderMarkdownPreviewBlock')
    const engine = new MarkdownPreviewDocumentEngine()
    engine.load('needle\n\n'.repeat(100))
    const pending = engine.search('needle')
    engine.cancelSearch()
    expect(await pending).toBeNull()
    expect(render).not.toHaveBeenCalled()
    expect((await engine.search('needle'))?.matches).toHaveLength(100)
    expect(render).not.toHaveBeenCalled()
    engine.load('needle replacement')
    expect((await engine.search('replacement'))?.matches).toHaveLength(1)
    expect(render).not.toHaveBeenCalled()
  })
})
