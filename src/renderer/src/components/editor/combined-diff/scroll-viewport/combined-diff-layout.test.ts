import { describe, expect, it } from 'vitest'
import { CombinedDiffExtentIndex, findDiffExtentEnd } from './combined-diff-extent-index'
import type { DiffItemExtent } from './combined-diff-layout'

function mapDiffViewportTop(input: {
  previous: DiffItemExtent[]
  next: DiffItemExtent[]
  top: number
  height: number
  direction: 'up' | 'down'
}): number {
  const index = new CombinedDiffExtentIndex()
  index.commit(input.previous, input.height, [], true)
  const keys = new Set(input.next.map((item) => item.key))
  const anchor = index.captureSizeAnchor(input.top, input.height, input.direction, (key) =>
    keys.has(key)
  )
  index.commit(input.next, input.height, [], true)
  return index.mapSizeAnchor(anchor, input.height)
}
import { diffRevealDisplacement, resolveDiffAnchorTop } from './combined-diff-layout'

describe('combined diff reading position', () => {
  it('keeps the reading position in the next file when an earlier file finishes measuring', () => {
    expect(
      mapDiffViewportTop({
        previous: [
          { key: 'earlier', height: 1000 },
          { key: 'reading', height: 800 }
        ],
        next: [
          { key: 'earlier', height: 600 },
          { key: 'reading', height: 800 }
        ],
        top: 1120,
        height: 400,
        direction: 'down'
      })
    ).toBe(720)
  })

  it('keeps a shrinking file at the lower viewport edge while scrolling upward', () => {
    expect(
      mapDiffViewportTop({
        previous: [
          { key: 'reading', height: 1000 },
          { key: 'later', height: 800 }
        ],
        next: [
          { key: 'reading', height: 300 },
          { key: 'later', height: 800 }
        ],
        top: 450,
        height: 400,
        direction: 'up'
      })
    ).toBe(-100)
  })

  it('keeps the end of the content at the viewport edge when the last file shrinks', () => {
    expect(
      mapDiffViewportTop({
        previous: [{ key: 'reading', height: 1000 }],
        next: [{ key: 'reading', height: 600 }],
        top: 600,
        height: 400,
        direction: 'up'
      })
    ).toBe(200)
  })
})

const reveal = {
  top: 700,
  bottom: 720,
  height: 600,
  chrome: 30,
  lineHeight: 20,
  surroundingLines: 0,
  surroundingLinesStyle: 'default' as const,
  source: 'api',
  minimalReveal: true,
  multipleSelections: false,
  verticalType: 0
}

describe('combined diff semantic reveal', () => {
  it('leaves a visible mouse target in place and reveals an offscreen target with its context', () => {
    expect(diffRevealDisplacement({ ...reveal, top: 130, bottom: 150, source: 'mouse' })).toBe(130)
    expect(diffRevealDisplacement({ ...reveal, surroundingLines: 3, minimalReveal: false })).toBe(
      520
    )
  })

  it('uses at least five lines above a near-top target without pushing the target below the viewport', () => {
    expect(diffRevealDisplacement({ ...reveal, height: 300, verticalType: 5 })).toBe(130)
    expect(diffRevealDisplacement({ ...reveal, height: 100, verticalType: 5 })).toBe(80)
  })

  it('does not navigate for separated cursors that cannot fit together', () => {
    expect(diffRevealDisplacement({ ...reveal, bottom: 1400, multipleSelections: true })).toBe(700)
  })
})

it('preserves a modified-pane reading point through unequal native scroll limits', () => {
  expect(
    resolveDiffAnchorTop({
      start: 100,
      height: 1000,
      renderedHeight: 400,
      currentTop: 400,
      nativeTarget: 800,
      chrome: 30,
      displacement: 150,
      originalMax: 600,
      modifiedMax: 500,
      originalToModified: 100,
      pane: 'modified'
    })
  ).toBe(880)
  expect(
    resolveDiffAnchorTop({
      start: 100,
      height: 1000,
      renderedHeight: 400,
      currentTop: 150,
      nativeTarget: 180,
      chrome: 30,
      displacement: 150,
      originalMax: 600,
      modifiedMax: 800,
      originalToModified: -100,
      pane: 'modified'
    })
  ).toBe(260)
})

describe('indexed combined geometry', () => {
  it('preserves compressed coordinates, negative slack and exact mixed-row boundaries', () => {
    const index = new CombinedDiffExtentIndex()
    index.commit(
      [
        { key: 'short', height: 100 },
        { key: 'empty', height: 0 },
        { key: 'tall', height: 1000 },
        { key: 'last', height: 200 }
      ],
      400,
      [],
      true
    )
    const layout = index.project(700, 400, 1, true)
    expect(layout.items).toEqual([
      {
        key: 'tall',
        start: 100,
        height: 1000,
        renderedStart: 100,
        renderedHeight: 400,
        scrollOffset: 600,
        visible: true
      }
    ])
    expect(layout.renderedTop).toBe(100)
    expect(index.anchorAt(1100)).toEqual({ key: 'last', offset: 0 })
    const slack = index.project(-100, 400, 1, true)
    expect(slack.leadingSlack).toBe(100)
    expect(slack.logicalTop).toBe(-100)
    expect(slack.items.map((item) => [item.key, item.renderedStart])).toEqual([
      ['short', 100],
      ['empty', 200],
      ['tall', 200]
    ])
    expect(index.project(1100, 400, 1, true).trailingSlack).toBe(200)
  })

  it('retains the next surviving file displacement when the reading file is removed', () => {
    expect(
      mapDiffViewportTop({
        previous: [
          { key: 'removed', height: 1000 },
          { key: 'next', height: 800 }
        ],
        next: [{ key: 'next', height: 800 }],
        top: 700,
        height: 400,
        direction: 'down'
      })
    ).toBe(-300)
  })

  it.each([200, 2000])('searches %i extent ends logarithmically', (count) => {
    let reads = 0
    const prefix = new Proxy(
      Array.from({ length: count + 1 }, (_, index) => index * 1000),
      {
        get(target, property) {
          if (typeof property === 'string' && /^\d+$/.test(property)) {
            reads++
            return target[Number(property)]
          }
          return property === 'length' ? target.length : undefined
        }
      }
    )
    expect(findDiffExtentEnd(prefix, (count - 7) * 1000 + 90)).toBe(count - 7)
    expect(reads).toBeLessThanOrEqual(Math.ceil(Math.log2(count + 1)) + 1)
  })
})
