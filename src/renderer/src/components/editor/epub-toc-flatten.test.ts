import { describe, expect, it } from 'vitest'
import { flattenEpubToc } from './epub-toc-flatten'

describe('flattenEpubToc', () => {
  it('flattens nested subitems into a depth-tagged list in reading order', () => {
    const toc = [
      { label: ' Chapter 1 ', href: 'ch1.xhtml', subitems: [] },
      {
        label: 'Chapter 2',
        href: 'ch2.xhtml',
        subitems: [{ label: 'Section 2.1', href: 'ch2.xhtml#s1', subitems: [] }]
      }
    ]

    expect(flattenEpubToc(toc)).toEqual([
      { label: 'Chapter 1', href: 'ch1.xhtml', depth: 0 },
      { label: 'Chapter 2', href: 'ch2.xhtml', depth: 0 },
      { label: 'Section 2.1', href: 'ch2.xhtml#s1', depth: 1 }
    ])
  })

  it('skips entries with no href so they cannot produce a dead navigation row', () => {
    const toc = [{ label: 'Part One', href: '', subitems: [] }]
    expect(flattenEpubToc(toc)).toEqual([])
  })

  it('returns an empty list when there is no table of contents', () => {
    expect(flattenEpubToc(undefined)).toEqual([])
  })
})
