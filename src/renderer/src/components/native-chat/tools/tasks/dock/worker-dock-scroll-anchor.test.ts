import { expect, it } from 'vitest'
import { workerDockAnchorIndex } from './worker-dock-scroll-anchor'

const anchor = {
  id: 'c',
  index: 2,
  offset: 9,
  order: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }, { id: 'f' }]
}

it('reanchors to the next surviving identity when removals change its array position', () => {
  expect(workerDockAnchorIndex(anchor, [{ id: 'a' }, { id: 'e' }, { id: 'f' }])).toBe(1)
})

it('uses the previous surviving identity when no later neighbor remains', () => {
  expect(workerDockAnchorIndex(anchor, [{ id: 'a' }, { id: 'b' }, { id: 'new' }])).toBe(1)
})
