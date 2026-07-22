import { describe, expect, it } from 'vitest'
import {
  buildWorktreeLineageInsertionOrderUpdates,
  getReorderedWorktreeIdsToUnnest,
  getWorktreeLineageInsertionBeforeChildId,
  getWorktreeLineageDropTarget,
  getWorktreeLineageDropTargetId,
  isWorktreeLineageDropZoneHit
} from './worktree-lineage-drag-drop'

describe('isWorktreeLineageDropZoneHit', () => {
  it('keeps the top and bottom of a card available for reorder drops', () => {
    const rect = { top: 100, bottom: 200 } as DOMRect

    expect(isWorktreeLineageDropZoneHit({ pointerY: 120, rect })).toBe(false)
    expect(isWorktreeLineageDropZoneHit({ pointerY: 150, rect })).toBe(true)
    expect(isWorktreeLineageDropZoneHit({ pointerY: 180, rect })).toBe(false)
  })

  it('caps the parent-drop band on tall cards', () => {
    const rect = { top: 0, bottom: 180 } as DOMRect

    expect(isWorktreeLineageDropZoneHit({ pointerY: 67, rect })).toBe(false)
    expect(isWorktreeLineageDropZoneHit({ pointerY: 90, rect })).toBe(true)
    expect(isWorktreeLineageDropZoneHit({ pointerY: 113, rect })).toBe(false)
  })
})

describe('getWorktreeLineageDropTargetId', () => {
  it('returns the row id only when the pointer is in the card content middle band', () => {
    const { container, target } = makeTarget({ worktreeId: 'parent', top: 100, bottom: 200 })

    expect(getWorktreeLineageDropTargetId({ container, target, pointerY: 120 })).toBeNull()
    expect(getWorktreeLineageDropTargetId({ container, target, pointerY: 150 })).toBe('parent')
  })

  it('excludes expanded descendants from the parent card drop-zone geometry', () => {
    const { container, target } = makeTarget({
      worktreeId: 'parent',
      top: 100,
      bottom: 300,
      lineageChildrenTop: 160
    })

    expect(getWorktreeLineageDropTargetId({ container, target, pointerY: 130 })).toBe('parent')
    expect(getWorktreeLineageDropTargetId({ container, target, pointerY: 200 })).toBeNull()
  })

  it('places the nesting guide between an expanded parent and its children', () => {
    const { container, target } = makeTarget({
      worktreeId: 'parent',
      top: 100,
      bottom: 300,
      lineageChildrenTop: 160,
      containerTop: 20,
      scrollTop: 400
    })

    expect(getWorktreeLineageDropTarget({ container, target, pointerY: 130 })).toEqual({
      parentId: 'parent',
      dropIndicatorY: 537
    })
  })

  it('places the nesting guide below a parent without expanded children', () => {
    const { container, target } = makeTarget({
      worktreeId: 'parent',
      top: 100,
      bottom: 200,
      containerTop: 20,
      scrollTop: 400
    })

    expect(getWorktreeLineageDropTarget({ container, target, pointerY: 150 })).toEqual({
      parentId: 'parent',
      dropIndicatorY: 583
    })
  })

  it('uses a child upper edge as an exact sibling insertion slot', () => {
    const { container, target } = makeTarget({
      worktreeId: 'child-b',
      lineageParentId: 'parent',
      directSiblingIds: ['child-a', 'child-b'],
      top: 200,
      bottom: 300,
      containerTop: 20,
      scrollTop: 400
    })

    expect(getWorktreeLineageDropTarget({ container, target, pointerY: 215 })).toEqual({
      parentId: 'parent',
      insertionBeforeChildId: 'child-b',
      dropIndicatorY: 577
    })
  })

  it('uses a child lower edge to insert before its next sibling', () => {
    const { container, target } = makeTarget({
      worktreeId: 'child-a',
      lineageParentId: 'parent',
      directSiblingIds: ['child-a', 'child-b'],
      top: 100,
      bottom: 200,
      containerTop: 20,
      scrollTop: 400
    })

    expect(getWorktreeLineageDropTarget({ container, target, pointerY: 185 })).toEqual({
      parentId: 'parent',
      insertionBeforeChildId: 'child-b',
      dropIndicatorY: 577
    })
  })

  it('uses the last child lower edge as the sibling-list append slot', () => {
    const { container, target } = makeTarget({
      worktreeId: 'child-b',
      lineageParentId: 'parent',
      directSiblingIds: ['child-a', 'child-b'],
      top: 200,
      bottom: 300,
      containerTop: 20,
      scrollTop: 400
    })

    expect(getWorktreeLineageDropTarget({ container, target, pointerY: 285 })).toEqual({
      parentId: 'parent',
      insertionBeforeChildId: null,
      dropIndicatorY: 683
    })
  })

  it('keeps the child center available as a deeper nesting target', () => {
    const { container, target } = makeTarget({
      worktreeId: 'child-a',
      lineageParentId: 'parent',
      directSiblingIds: ['child-a', 'child-b'],
      top: 100,
      bottom: 200,
      containerTop: 20,
      scrollTop: 400
    })

    expect(getWorktreeLineageDropTarget({ container, target, pointerY: 150 })).toEqual({
      parentId: 'child-a',
      dropIndicatorY: 583
    })
  })

  it('ignores content targets outside the sidebar container', () => {
    const { container, target } = makeTarget({
      worktreeId: 'parent',
      top: 100,
      bottom: 200,
      contained: false
    })

    expect(getWorktreeLineageDropTargetId({ container, target, pointerY: 150 })).toBeNull()
  })
})

describe('getWorktreeLineageInsertionBeforeChildId', () => {
  const orderIndexById = new Map([
    ['above', 0],
    ['parent', 1],
    ['child-a', 2],
    ['child-b', 3],
    ['below', 4]
  ])

  it('inserts an earlier workspace before the first child', () => {
    expect(
      getWorktreeLineageInsertionBeforeChildId({
        directChildIds: ['child-a', 'child-b'],
        draggedIds: ['above'],
        orderIndexById
      })
    ).toBe('child-a')
  })

  it('appends a later workspace after the existing children', () => {
    expect(
      getWorktreeLineageInsertionBeforeChildId({
        directChildIds: ['child-a', 'child-b'],
        draggedIds: ['below'],
        orderIndexById
      })
    ).toBeNull()
  })

  it('ignores a dragged child when resolving its current sibling slot', () => {
    expect(
      getWorktreeLineageInsertionBeforeChildId({
        directChildIds: ['child-a', 'child-b'],
        draggedIds: ['child-a'],
        orderIndexById
      })
    ).toBe('child-b')
  })
})

describe('buildWorktreeLineageInsertionOrderUpdates', () => {
  const orderIndexById = new Map([
    ['root', 0],
    ['child-a', 1],
    ['child-b', 2]
  ])
  const rankByWorktreeId = new Map([
    ['root', 4000],
    ['child-a', 3000],
    ['child-b', 1000]
  ])

  it('ranks a root workspace into the pointed-at child gap', () => {
    expect(
      Array.from(
        buildWorktreeLineageInsertionOrderUpdates({
          directChildIds: ['child-a', 'child-b'],
          draggedIds: ['root'],
          insertionBeforeChildId: 'child-b',
          orderIndexById,
          rankByWorktreeId,
          now: 10_000
        })
      )
    ).toEqual([['root', { manualOrder: 2000 }]])
  })

  it('does not rewrite ranks for a child dropped back into its current gap', () => {
    expect(
      buildWorktreeLineageInsertionOrderUpdates({
        directChildIds: ['child-a', 'child-b'],
        draggedIds: ['child-a'],
        insertionBeforeChildId: 'child-b',
        orderIndexById,
        rankByWorktreeId,
        now: 10_000
      }).size
    ).toBe(0)
  })
})

describe('getReorderedWorktreeIdsToUnnest', () => {
  it('clears parents only for directly dragged nested cards', () => {
    expect(
      getReorderedWorktreeIdsToUnnest({
        draggedIds: ['child', 'child', 'root', 'grandchild'],
        sourceGroupIds: ['child', 'root', 'grandchild'],
        lineageById: {
          child: true,
          grandchild: true
        }
      })
    ).toEqual(['child', 'grandchild'])
  })

  it('does not clear selected nested cards outside the reordered source group', () => {
    expect(
      getReorderedWorktreeIdsToUnnest({
        draggedIds: ['source-child', 'other-child'],
        sourceGroupIds: ['source-child'],
        lineageById: {
          'source-child': true,
          'other-child': true
        }
      })
    ).toEqual(['source-child'])
  })
})

function makeTarget(args: {
  worktreeId: string
  top: number
  bottom: number
  lineageParentId?: string
  directSiblingIds?: readonly string[]
  lineageChildrenTop?: number
  containerTop?: number
  scrollTop?: number
  contained?: boolean
}): {
  container: HTMLElement
  target: Element
} {
  const siblingIds = args.directSiblingIds ?? [args.worktreeId]
  const currentSiblingIndex = Math.max(0, siblingIds.indexOf(args.worktreeId))
  const rowHeight = args.bottom - args.top
  const siblingRows = siblingIds.map(
    (worktreeId, index) =>
      ({
        getAttribute: (name: string) => {
          if (name === 'data-worktree-drag-id') {
            return worktreeId
          }
          if (name === 'data-worktree-lineage-parent-id') {
            return args.lineageParentId ?? null
          }
          if (name === 'data-worktree-section-key') {
            return 'section'
          }
          return null
        },
        getBoundingClientRect: () => {
          const top = args.top + (index - currentSiblingIndex) * rowHeight
          return { top, bottom: top + rowHeight }
        }
      }) as HTMLElement
  )
  const row = siblingRows[currentSiblingIndex]!
  const lineageChildren =
    args.lineageChildrenTop === undefined
      ? null
      : ({
          getBoundingClientRect: () => ({ top: args.lineageChildrenTop })
        } as HTMLElement)
  const content = {
    getBoundingClientRect: () => ({ top: args.top, bottom: args.bottom }),
    querySelector: (selector: string) =>
      selector === '[data-worktree-lineage-children]' ? lineageChildren : null,
    closest: (selector: string) => (selector === '[data-worktree-drag-id]' ? row : null)
  } as unknown as HTMLElement
  const target = {
    closest: (selector: string) =>
      selector === '[data-worktree-card-hover-trigger]' ? content : null
  } as Element
  const contained = args.contained ?? true
  const container = {
    contains: (element: Element) =>
      contained && (element === content || siblingRows.includes(element as HTMLElement)),
    querySelectorAll: (selector: string) =>
      selector === '[data-worktree-drag-id]' ? siblingRows : [],
    getBoundingClientRect: () => ({ top: args.containerTop ?? 0 }),
    scrollTop: args.scrollTop ?? 0
  } as unknown as HTMLElement
  return { container, target }
}
