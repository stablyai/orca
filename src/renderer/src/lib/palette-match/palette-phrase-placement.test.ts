import { describe, expect, it } from 'vitest'
import { buildPaletteTabDocument } from './tab-document'
import { matchPaletteTabDocument, preparePaletteTabQuery } from './tab-match'

function documentWithTitle(title: string) {
  return buildPaletteTabDocument({
    id: 'page',
    title,
    secondaryTexts: [],
    worktreeName: '',
    branch: '',
    repoName: ''
  })
}

describe('palette phrase placement', () => {
  it.each([
    ['aa example', 'aa', 0],
    ['baaa aa example', 'aa', 1],
    ['baaa baaa', 'aa', 2],
    ['prefix fooBar baz', 'bar baz', 1],
    ['prefix café noir', 'café noir', 1],
    ['prefix foo/bar baz', 'bar baz', 1],
    ['prefix 123abc', 'abc', 1],
    ['prefix baaa aa', 'aa', 1]
  ])('preserves placement for %s / %s', (title, query, placement) => {
    expect(
      matchPaletteTabDocument(documentWithTitle(title), preparePaletteTabQuery(query)!)?.rank
        .placement
    ).toBe(placement)
  })

  it('bounds word-start reads with repeated interior substring matches', () => {
    const document = documentWithTitle('baaa '.repeat(1000))
    const field = document.visibleFields[0]
    let reads = 0
    for (const word of field.words) {
      const start = word.start
      Object.defineProperty(word, 'start', {
        get: () => {
          reads += 1
          return start
        }
      })
    }
    const match = matchPaletteTabDocument(document, preparePaletteTabQuery('aa')!)
    expect(match?.rank.placement).toBe(2)
    expect(match?.titleRanges).toEqual([{ start: 1, end: 3 }])
    expect(reads).toBeLessThanOrEqual(field.words.length * 10)
  })
})
