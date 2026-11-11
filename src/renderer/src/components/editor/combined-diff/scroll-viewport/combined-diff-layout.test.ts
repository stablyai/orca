import { describe, expect, it } from 'vitest'
import {
  diffRevealDisplacement,
  mapDiffViewportTop,
  resolveDiffAnchorTop
} from './combined-diff-layout'

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
