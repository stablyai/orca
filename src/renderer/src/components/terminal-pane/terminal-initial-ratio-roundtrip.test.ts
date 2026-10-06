// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { wrapInSplit } from '@/lib/pane-manager/pane-tree-ops'
import { serializePaneTree } from './layout-serialization'

function splitElements(ratio: number | undefined) {
  const root = document.createElement('div')
  const first = document.createElement('div')
  const second = document.createElement('div')
  first.className = second.className = 'pane'
  first.dataset.leafId = '11111111-1111-4111-8111-111111111111'
  second.dataset.leafId = '22222222-2222-4222-8222-222222222222'
  root.append(first)
  wrapInSplit(first, second, true, document.createElement('div'), { ratio })
  const split = root.firstElementChild
  if (!(split instanceof HTMLElement)) {
    throw new Error('split container missing')
  }
  return { first, second, layout: serializePaneTree(split) }
}

describe('initial terminal ratio round trip', () => {
  it.each([0.0001, 0.0004, 0.9996, 0.9999])(
    'preserves a valid %s split when rounding would hit an endpoint',
    (ratio) => {
      const saved = splitElements(ratio).layout
      if (saved?.type !== 'split' || saved.ratio === undefined) {
        throw new Error('custom split ratio missing')
      }
      expect(saved.ratio).toBeGreaterThan(0)
      expect(saved.ratio).toBeLessThan(1)
      expect(saved.ratio).toBeCloseTo(ratio, 8)
      const restored = splitElements(saved.ratio)
      expect(Number.parseFloat(restored.first.style.flex)).toBeCloseTo(ratio, 8)
      expect(Number.parseFloat(restored.second.style.flex)).toBeCloseTo(1 - ratio, 8)
      expect(restored.layout).toEqual(saved)
    }
  )

  it('keeps ordinary rounding and the existing near-half default', () => {
    expect(splitElements(0.8546).layout).toMatchObject({ ratio: 0.855 })
    for (const ratio of [undefined, 0.499, 0.5, 0.501]) {
      expect(splitElements(ratio).layout).not.toHaveProperty('ratio')
    }
  })
})
