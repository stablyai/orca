import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownPreviewDocumentEngine } from './markdown-preview-document-engine'
import * as documentTree from './markdown-preview-document-tree'
import type * as DocumentTypes from './markdown-preview-document-types'

vi.mock('./markdown-preview-document-types', async () => ({
  ...(await vi.importActual<typeof DocumentTypes>('./markdown-preview-document-types')),
  MARKDOWN_PREVIEW_SEARCH_TEXT_MAX_BYTES: 32,
  MARKDOWN_PREVIEW_SEARCH_TEXT_MAX_NODES: 3
}))

afterEach(() => vi.restoreAllMocks())

describe('large preview search index budgets', () => {
  it('bounds retained text bytes, leaves viewport rendering available, and resets on replacement', async () => {
    const render = vi.spyOn(documentTree, 'renderMarkdownPreviewBlock')
    const engine = new MarkdownPreviewDocumentEngine()
    engine.load('12345678\n\nabcdefgh\n\nexhaust')
    await expect(engine.search('missing')).rejects.toThrow('search limit')
    const calls = render.mock.calls.length
    await expect(engine.search('123')).rejects.toThrow('search limit')
    expect(render).toHaveBeenCalledTimes(calls)
    expect(engine.blocks([2])[0].oversized).toBe(false)
    engine.load('# New')
    expect((await engine.search('New'))?.matches).toHaveLength(1)
  })

  it('bounds retained text nodes independently of bytes', async () => {
    const engine = new MarkdownPreviewDocumentEngine()
    engine.load('a\n\nb\n\nc\n\nd')
    await expect(engine.search('missing')).rejects.toThrow('search limit')
    expect(engine.blocks([3])[0].oversized).toBe(false)
  })
})
