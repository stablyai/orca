// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { parseDiffFromFile } from '@pierre/diffs'
import { estimateDiffOverview } from './pierre-diff-overview'

it('locates both lanes without mounting any rows, including a later collapsed hunk', () => {
  const original = Array.from({ length: 100 }, (_, index) => `line ${index + 1}\n`)
  const modified = [...original]
  modified[1] = 'first replacement\n'
  modified[98] = 'last replacement\n'
  const diff = parseDiffFromFile(
    { name: 'file.txt', contents: original.join('') },
    { name: 'file.txt', contents: modified.join('') }
  )
  const split = estimateDiffOverview(diff, true)
  expect(split).toEqual({
    height: 304,
    markers: [
      { top: 28, height: 20, side: 'deletions' },
      { top: 28, height: 20, side: 'additions' },
      { top: 256, height: 20, side: 'deletions' },
      { top: 256, height: 20, side: 'additions' }
    ]
  })
  const unified = estimateDiffOverview(diff, false)
  expect(unified.markers).toEqual([
    { top: 28, height: 20, side: 'deletions' },
    { top: 48, height: 20, side: 'additions' },
    { top: 276, height: 20, side: 'deletions' },
    { top: 296, height: 20, side: 'additions' }
  ])
})
