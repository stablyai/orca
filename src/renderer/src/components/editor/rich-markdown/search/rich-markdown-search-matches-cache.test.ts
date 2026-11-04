import { Schema } from '@tiptap/pm/model'
import { describe, expect, it, vi } from 'vitest'
import { findRichMarkdownSearchMatches } from './rich-markdown-search'
import { createRichMarkdownSearchMatchesCache } from './rich-markdown-search-matches-cache'

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*' },
    text: {}
  }
})

function createDoc(text = 'Beta beta betas', count = 1) {
  return schema.node(
    'doc',
    null,
    Array.from({ length: count }, () => schema.node('paragraph', null, schema.text(text)))
  )
}

describe('rich markdown search match reuse', () => {
  it('keeps separate live and debounced results without rewalking the document', () => {
    const doc = createDoc()
    const find = createRichMarkdownSearchMatchesCache()
    const walk = vi.spyOn(doc, 'nodesBetween')
    const highlighted = find(doc, 'beta')
    const live = find(doc, 'betas')
    for (let index = 0; index < 100; index++) {
      expect(find(doc, 'beta')).toBe(highlighted)
      expect(find(doc, 'betas')).toBe(live)
    }
    expect(walk).toHaveBeenCalledTimes(2)
  })

  it('keys by document and both matching options', () => {
    const find = createRichMarkdownSearchMatchesCache()
    const doc = createDoc()
    const anyCase = find(doc, 'beta')
    expect(find(doc, 'beta', { matchCase: false, wholeWord: false })).toBe(anyCase)
    for (const options of [
      { matchCase: true },
      { wholeWord: true },
      { matchCase: true, wholeWord: true }
    ]) {
      expect(find(doc, 'beta', options)).toEqual(
        findRichMarkdownSearchMatches(doc, 'beta', options)
      )
    }
    const changedDoc = createDoc('A different beta')
    expect(find(changedDoc, 'beta')).toEqual(findRichMarkdownSearchMatches(changedDoc, 'beta'))
    expect(find(doc, 'beta')).not.toBe(anyCase)
  })
})
