// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { MarkdownPreviewDocumentEngine } from './markdown-preview-document-engine'
import {
  applyMarkdownPreviewSearchHighlights,
  clearMarkdownPreviewSearchHighlights,
  setActiveMarkdownPreviewSearchMatch
} from './markdown-preview-search'

describe('virtual preview document search scope', () => {
  it('keeps worker occurrences aligned with document text around saved notes and copy labels', async () => {
    const engine = new MarkdownPreviewDocumentEngine()
    engine.load('> First needle.\n>\n> Second needle.')
    const result = await engine.search('needle')
    const body = document.createElement('div')
    body.innerHTML = `<blockquote>
      <p>First needle.</p>
      <div class="markdown-annotation-controls">Saved note quoting needle.</div>
      <button class="code-block-copy-btn">needle</button>
      <div data-orca-export-hide="true">needle</div>
      <p>Second needle.</p>
    </blockquote>`
    const instance = {}
    const ranges = applyMarkdownPreviewSearchHighlights(instance, body, 'needle', {
      documentOnly: true
    })
    expect(result?.matches).toEqual([
      { block: 0, occurrence: 0 },
      { block: 0, occurrence: 1 }
    ])
    expect(ranges.map((range) => range.startContainer.textContent)).toEqual([
      'First needle.',
      'Second needle.'
    ])
    const scroll = vi.spyOn(body.querySelector('p')!, 'scrollIntoView')
    setActiveMarkdownPreviewSearchMatch(instance, ranges, 0, { scrollIntoView: false })
    expect(scroll).not.toHaveBeenCalled()
    setActiveMarkdownPreviewSearchMatch(instance, ranges, 0)
    expect(scroll).toHaveBeenCalledOnce()
    clearMarkdownPreviewSearchHighlights(instance)
  })

  it('maps matches across syntax spans without expanding offscreen code', async () => {
    const engine = new MarkdownPreviewDocumentEngine()
    engine.load('```javascript\nconst needle = 42\n```')
    const result = await engine.search('const needle')
    const body = document.createElement('div')
    body.innerHTML =
      '<pre><code><span class="hljs-keyword">const</span> needle = <span class="hljs-number">42</span>\n</code><button class="code-block-copy-btn">Copy</button></pre>'
    const instance = {}
    const ranges = applyMarkdownPreviewSearchHighlights(instance, body, 'const needle', {
      documentOnly: true
    })
    expect(result?.matches).toEqual([{ block: 0, occurrence: 0 }])
    expect(ranges.map((range) => range.toString())).toEqual(['const needle'])
    expect(
      applyMarkdownPreviewSearchHighlights(instance, body, 'needle = 42', {
        documentOnly: true
      }).map((range) => range.toString())
    ).toEqual(['needle = 42'])
    clearMarkdownPreviewSearchHighlights(instance)
  })

  it('uses the same outer code group for nested raw HTML code', async () => {
    const engine = new MarkdownPreviewDocumentEngine()
    engine.load('<code><code>needle</code> suffix</code>')
    const body = document.createElement('div')
    body.innerHTML = '<code><code>needle</code> suffix</code>'
    const instance = {}
    const ranges = applyMarkdownPreviewSearchHighlights(instance, body, 'needle suffix', {
      documentOnly: true
    })
    expect((await engine.search('needle suffix'))?.matches).toEqual([{ block: 0, occurrence: 0 }])
    expect(ranges.map((range) => range.toString())).toEqual(['needle suffix'])
    clearMarkdownPreviewSearchHighlights(instance)
  })

  it('ignores whitespace-only code groups while retaining spaces within code', async () => {
    const engine = new MarkdownPreviewDocumentEngine()
    engine.load('before ` ` after space')
    const body = document.createElement('div')
    body.innerHTML = '<p>before <code> </code> after space</p>'
    const instance = {}
    const ranges = applyMarkdownPreviewSearchHighlights(instance, body, ' ', { documentOnly: true })
    expect((await engine.search(' '))?.matches).toHaveLength(3)
    expect(ranges).toHaveLength(3)
    expect(ranges.map((range) => range.startContainer.textContent)).toEqual([
      'before ',
      ' after space',
      ' after space'
    ])
    clearMarkdownPreviewSearchHighlights(instance)
  })

  it('ignores whitespace-only text in both worker and mounted ranges', async () => {
    const engine = new MarkdownPreviewDocumentEngine()
    engine.load('<span> </span>word space')
    const result = await engine.search(' ')
    const body = document.createElement('div')
    body.innerHTML = '<span> </span>word space'
    const instance = {}
    const ranges = applyMarkdownPreviewSearchHighlights(instance, body, ' ', { documentOnly: true })
    expect(result?.matches).toHaveLength(1)
    expect(ranges).toHaveLength(1)
    expect(ranges[0].startContainer.textContent).toBe('word space')
    clearMarkdownPreviewSearchHighlights(instance)
  })
})
