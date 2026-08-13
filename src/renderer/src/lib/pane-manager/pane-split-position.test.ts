// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { serializePaneTree } from '@/components/terminal-pane/layout-serialization'
import { wrapInSplit } from './pane-tree-ops'

const LEAF_IDS = {
  '1': '11111111-1111-4111-8111-111111111111',
  '2': '22222222-2222-4222-8222-222222222222'
} as const

function makePane(id: '1' | '2'): HTMLElement {
  const el = document.createElement('div')
  el.className = 'pane'
  el.dataset.paneId = id
  el.dataset.leafId = LEAF_IDS[id]
  return el
}

function setup(): { root: HTMLElement; existing: HTMLElement; created: HTMLElement } {
  const root = document.createElement('div')
  const existing = makePane('1')
  root.appendChild(existing)
  return { root, existing, created: makePane('2') }
}

function paneOrder(root: HTMLElement): string[] {
  const split = root.firstElementChild as HTMLElement
  return [...split.children].map((child) =>
    child.classList.contains('pane') ? (child as HTMLElement).dataset.paneId! : 'divider'
  )
}

describe('wrapInSplit position', () => {
  it('appends the new pane after the source pane by default', () => {
    const { root, existing, created } = setup()

    wrapInSplit(existing, created, true, document.createElement('div'))

    expect(paneOrder(root)).toEqual(['1', 'divider', '2'])
  })

  it('places the new pane before the source pane for split left/up', () => {
    const { root, existing, created } = setup()

    wrapInSplit(existing, created, true, document.createElement('div'), { position: 'before' })

    expect(paneOrder(root)).toEqual(['2', 'divider', '1'])
  })

  it('keeps the divider between the panes in both orders', () => {
    const { root, existing, created } = setup()

    wrapInSplit(existing, created, false, document.createElement('div'), { position: 'before' })

    expect(paneOrder(root)[1]).toBe('divider')
    expect((root.firstElementChild as HTMLElement).className).toContain('is-horizontal')
  })

  it('serializes a leading split so a restored layout keeps the new pane on the left', () => {
    // Why: replay only ever splits 'after' and rebuilds from tree order, so the
    // serialized `first` must be the pane the user actually sees on the left.
    const { root, existing, created } = setup()

    wrapInSplit(existing, created, true, document.createElement('div'), {
      ratio: 0.3,
      position: 'before'
    })

    expect(serializePaneTree(root.firstElementChild as HTMLElement)).toEqual({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF_IDS['2'] },
      second: { type: 'leaf', leafId: LEAF_IDS['1'] },
      ratio: 0.3
    })
  })

  it('applies the ratio to whichever pane leads, so a replayed layout keeps its sizes', () => {
    const after = setup()
    wrapInSplit(after.existing, after.created, true, document.createElement('div'), { ratio: 0.25 })
    expect(after.existing.style.flex).toBe('0.25 1 0%')
    expect(after.created.style.flex).toBe('0.75 1 0%')

    const before = setup()
    wrapInSplit(before.existing, before.created, true, document.createElement('div'), {
      ratio: 0.25,
      position: 'before'
    })
    expect(before.created.style.flex).toBe('0.25 1 0%')
    expect(before.existing.style.flex).toBe('0.75 1 0%')
  })
})
