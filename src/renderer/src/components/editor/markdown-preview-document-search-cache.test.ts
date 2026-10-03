import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownPreviewDocumentEngine } from './markdown-preview-document-engine'
import * as documentTree from './markdown-preview-document-tree'

afterEach(() => vi.restoreAllMocks())

describe('large preview searchable text ownership', () => {
  it('indexes expanded text once across queries without evicting viewport blocks', async () => {
    const render = vi.spyOn(documentTree, 'renderMarkdownPreviewBlock')
    const engine = new MarkdownPreviewDocumentEngine()
    engine.load(
      Array.from(
        { length: 100 },
        (_, index) => `\`\`\`javascript\nconst needle${index} = 42\n\`\`\`\n\n$x^2$\n`
      ).join('\n')
    )
    const viewport = engine.blocks([0, 1])
    expect((await engine.search('needle'))?.matches).toHaveLength(100)
    const calls = render.mock.calls.length
    expect(calls).toBe(200)
    expect((await engine.search('const'))?.matches).toHaveLength(100)
    expect((await engine.search('absent'))?.matches).toHaveLength(0)
    expect(render).toHaveBeenCalledTimes(calls)
    expect(engine.blocks([0, 1])).toEqual(viewport)
    expect(engine.blocks([0])[0]).toBe(viewport[0])
    expect(render).toHaveBeenCalledTimes(calls)
  })

  it('cancels indexing, retains completed text, and clears it on document replacement', async () => {
    const render = vi.spyOn(documentTree, 'renderMarkdownPreviewBlock')
    const engine = new MarkdownPreviewDocumentEngine()
    engine.load('needle\n\n'.repeat(100))
    const pending = engine.search('needle')
    engine.cancelSearch()
    expect(await pending).toBeNull()
    expect(render).toHaveBeenCalledTimes(16)
    expect((await engine.search('needle'))?.matches).toHaveLength(100)
    expect(render).toHaveBeenCalledTimes(100)
    engine.load('needle replacement')
    expect((await engine.search('replacement'))?.matches).toHaveLength(1)
    expect(render).toHaveBeenCalledTimes(101)
  })
})
