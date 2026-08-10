// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import type { Worktree, WorktreeLineage } from '../../../../shared/types'
import { getCyclicProjectedWorktreeLineageIds } from './worktree-lineage-projection'
import {
  getReorderedWorktreeIdsToUnnest,
  getTopLevelWorktreeLineageDragIds,
  getWorktreeLineageDragRootId,
  getWorktreeLineageDropTargetId,
  isWorktreeLineageDropZoneHit
} from './worktree-lineage-drag-drop'

describe('isWorktreeLineageDropZoneHit', () => {
  it('keeps the top and bottom of a card available for reorder drops', () => {
    const rect = { top: 100, bottom: 200 } as DOMRect

    expect(isWorktreeLineageDropZoneHit({ pointerY: 107, rect })).toBe(false)
    expect(isWorktreeLineageDropZoneHit({ pointerY: 150, rect })).toBe(true)
    expect(isWorktreeLineageDropZoneHit({ pointerY: 193, rect })).toBe(false)
  })

  it('keeps expanded owned content available without moving the target to its center', () => {
    const rect = { top: 0, bottom: 500 } as DOMRect

    expect(isWorktreeLineageDropZoneHit({ pointerY: 7, rect })).toBe(false)
    expect(isWorktreeLineageDropZoneHit({ pointerY: 24, rect })).toBe(true)
    expect(isWorktreeLineageDropZoneHit({ pointerY: 476, rect })).toBe(true)
  })
})

describe('getWorktreeLineageDropTargetId', () => {
  it('targets the owned title and agent surface while preserving edge reorder gutters', () => {
    const { container, target } = makeTarget({ worktreeId: 'parent', top: 100, bottom: 200 })

    expect(
      getWorktreeLineageDropTargetId({ container, target, pointerX: 100, pointerY: 106 })
    ).toBeNull()
    expect(
      getWorktreeLineageDropTargetId({ container, target, pointerX: 100, pointerY: 120 })
    ).toBe('parent')
    expect(
      getWorktreeLineageDropTargetId({ container, target, pointerX: 100, pointerY: 150 })
    ).toBe('parent')
  })

  it('keeps a tall parent target stable across every owned agent row', () => {
    const { container, surface } = makeTarget({
      worktreeId: 'parent',
      top: 100,
      bottom: 600
    })
    const agentRow = document.createElement('div')
    surface.appendChild(agentRow)

    expect(
      getWorktreeLineageDropTargetId({
        container,
        target: agentRow,
        pointerX: 100,
        pointerY: 124
      })
    ).toBe('parent')
    expect(
      getWorktreeLineageDropTargetId({
        container,
        target: agentRow,
        pointerX: 100,
        pointerY: 480
      })
    ).toBe('parent')
  })

  it('targets the deepest child surface and leaves lineage-container gaps for reorder', () => {
    const { container, surface } = makeTarget({
      worktreeId: 'parent',
      top: 100,
      bottom: 600
    })
    const children = document.createElement('div')
    children.setAttribute('data-worktree-lineage-children', '')
    setVerticalRect(children, 260, 600)
    surface.appendChild(children)
    const childRow = document.createElement('div')
    childRow.setAttribute('data-worktree-lineage-drop-id', 'child')
    const childSurface = document.createElement('div')
    childSurface.setAttribute('data-worktree-card-surface', 'true')
    setVerticalRect(childSurface, 300, 360)
    childRow.appendChild(childSurface)
    children.appendChild(childRow)

    expect(
      getWorktreeLineageDropTargetId({
        container,
        target: childSurface,
        pointerX: 100,
        pointerY: 330
      })
    ).toBe('child')
    expect(
      getWorktreeLineageDropTargetId({
        container,
        target: children,
        pointerX: 100,
        pointerY: 280
      })
    ).toBeNull()
  })

  it('leaves legacy lineage-container gaps for reorder', () => {
    const { container, surface } = makeTarget({
      worktreeId: 'parent',
      top: 100,
      bottom: 600
    })
    const children = document.createElement('div')
    children.setAttribute('data-worktree-legacy-lineage-children', '')
    setVerticalRect(children, 260, 600)
    surface.appendChild(children)

    expect(
      getWorktreeLineageDropTargetId({
        container,
        target: children,
        pointerX: 100,
        pointerY: 280
      })
    ).toBeNull()
  })

  it('targets pinned copies that are not reorder sources', () => {
    const { container, target, row } = makeTarget({
      worktreeId: 'pinned-parent',
      top: 100,
      bottom: 140
    })

    expect(row.hasAttribute('data-worktree-drag-id')).toBe(false)
    expect(
      getWorktreeLineageDropTargetId({ container, target, pointerX: 100, pointerY: 120 })
    ).toBe('pinned-parent')
  })

  it('ignores worktree surfaces while deletion is in progress', () => {
    const { container, target, surface } = makeTarget({
      worktreeId: 'deleting-parent',
      top: 100,
      bottom: 200
    })
    surface.setAttribute('aria-busy', 'true')

    expect(
      getWorktreeLineageDropTargetId({ container, target, pointerX: 100, pointerY: 150 })
    ).toBeNull()
  })

  it('ignores child surfaces beneath a deleting ancestor overlay', () => {
    const {
      container,
      target: overlay,
      surface
    } = makeTarget({
      worktreeId: 'deleting-parent',
      top: 100,
      bottom: 300
    })
    surface.setAttribute('aria-busy', 'true')
    const children = document.createElement('div')
    children.setAttribute('data-worktree-lineage-children', '')
    const childRow = document.createElement('div')
    childRow.setAttribute('data-worktree-lineage-drop-id', 'child')
    const childSurface = document.createElement('div')
    childSurface.setAttribute('data-worktree-card-surface', 'true')
    setVerticalRect(childSurface, 160, 220)
    childRow.appendChild(childSurface)
    children.appendChild(childRow)
    surface.appendChild(children)

    expect(
      getWorktreeLineageDropTargetId({
        container,
        target: overlay,
        pointerX: 100,
        pointerY: 180
      })
    ).toBeNull()
  })

  it('ignores content targets outside the sidebar container', () => {
    const { container, target } = makeTarget({
      worktreeId: 'parent',
      top: 100,
      bottom: 200,
      contained: false
    })

    expect(
      getWorktreeLineageDropTargetId({ container, target, pointerX: 100, pointerY: 150 })
    ).toBeNull()
  })
})

describe('getTopLevelWorktreeLineageDragIds', () => {
  it('keeps selected subtrees intact when an ancestor and descendant are selected', () => {
    const parent = makeWorktree('parent')
    const child = makeWorktree('child')
    const grandchild = makeWorktree('grandchild')
    const root = makeWorktree('root')
    const lineageById = {
      [child.id]: makeLineage(child, parent),
      [grandchild.id]: makeLineage(grandchild, child)
    }
    const worktreeMap = new Map([parent, child, grandchild, root].map((item) => [item.id, item]))

    expect(
      getTopLevelWorktreeLineageDragIds({
        draggedIds: ['grandchild', 'root', 'parent', 'child', 'root'],
        lineageById,
        worktreeMap,
        cyclicLineageIds: getCyclicProjectedWorktreeLineageIds(lineageById, worktreeMap)
      })
    ).toEqual(['root', 'parent'])
  })

  it('uses the selected ancestor root as geometry when its child starts the drag', () => {
    const parent = makeWorktree('parent')
    const child = makeWorktree('child')
    const other = makeWorktree('other')
    const lineageById = { [child.id]: makeLineage(child, parent) }
    const worktreeMap = new Map([parent, child, other].map((item) => [item.id, item]))
    const cyclicLineageIds = getCyclicProjectedWorktreeLineageIds(lineageById, worktreeMap)

    expect(
      getWorktreeLineageDragRootId({
        worktreeId: child.id,
        lineageRootIds: [parent.id, other.id],
        lineageById,
        worktreeMap,
        cyclicLineageIds
      })
    ).toBe(parent.id)
    expect(
      getWorktreeLineageDragRootId({
        worktreeId: other.id,
        lineageRootIds: [parent.id, other.id],
        lineageById,
        worktreeMap,
        cyclicLineageIds
      })
    ).toBe(other.id)
  })
})

describe('getReorderedWorktreeIdsToUnnest', () => {
  it('clears parents only for directly dragged nested cards', () => {
    const parent = makeWorktree('parent')
    const child = makeWorktree('child')
    const root = makeWorktree('root')
    const grandchild = makeWorktree('grandchild')
    const lineageById = {
      [child.id]: makeLineage(child, parent),
      [grandchild.id]: makeLineage(grandchild, child)
    }
    const worktreeMap = new Map([parent, child, root, grandchild].map((item) => [item.id, item]))

    expect(
      getReorderedWorktreeIdsToUnnest({
        draggedIds: ['child', 'child', 'root', 'grandchild'],
        sourceGroupIds: ['child', 'root', 'grandchild'],
        lineageById,
        worktreeMap,
        cyclicLineageIds: getCyclicProjectedWorktreeLineageIds(lineageById, worktreeMap)
      })
    ).toEqual(['child', 'grandchild'])
  })

  it('does not clear selected nested cards outside the reordered source group', () => {
    const parent = makeWorktree('parent')
    const sourceChild = makeWorktree('source-child')
    const otherChild = makeWorktree('other-child')
    const lineageById = {
      [sourceChild.id]: makeLineage(sourceChild, parent),
      [otherChild.id]: makeLineage(otherChild, parent)
    }
    const worktreeMap = new Map([parent, sourceChild, otherChild].map((item) => [item.id, item]))

    expect(
      getReorderedWorktreeIdsToUnnest({
        draggedIds: ['source-child', 'other-child'],
        sourceGroupIds: ['source-child'],
        lineageById,
        worktreeMap,
        cyclicLineageIds: getCyclicProjectedWorktreeLineageIds(lineageById, worktreeMap)
      })
    ).toEqual(['source-child'])
  })

  it('clears an exact inline-only legacy parent', () => {
    const parent = makeWorktree('parent')
    const child = makeWorktree('child')
    const inlineChild = { ...child, lineage: makeLineage(child, parent) } as Worktree
    const worktreeMap = new Map([parent, inlineChild].map((item) => [item.id, item]))

    expect(
      getReorderedWorktreeIdsToUnnest({
        draggedIds: [child.id],
        sourceGroupIds: [child.id],
        lineageById: {},
        worktreeMap,
        cyclicLineageIds: getCyclicProjectedWorktreeLineageIds({}, worktreeMap)
      })
    ).toEqual([child.id])
  })

  it('does not fall back to inline lineage when the side-map has a stale child entry', () => {
    const parent = makeWorktree('parent')
    const child = makeWorktree('child')
    const inlineChild = { ...child, lineage: makeLineage(child, parent) } as Worktree
    const lineageById = {
      [child.id]: { ...makeLineage(child, parent), parentWorktreeInstanceId: 'stale-parent' }
    }
    const worktreeMap = new Map([parent, inlineChild].map((item) => [item.id, item]))

    expect(
      getReorderedWorktreeIdsToUnnest({
        draggedIds: [child.id],
        sourceGroupIds: [child.id],
        lineageById,
        worktreeMap,
        cyclicLineageIds: getCyclicProjectedWorktreeLineageIds(lineageById, worktreeMap)
      })
    ).toEqual([])
  })
})

function makeWorktree(id: string): Worktree {
  return {
    id,
    instanceId: `${id}-instance`,
    repoId: 'repo-1',
    path: `/worktrees/${id}`,
    head: 'abc123',
    branch: id,
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1
  }
}

function makeLineage(child: Worktree, parent: Worktree): WorktreeLineage {
  return {
    worktreeId: child.id,
    worktreeInstanceId: child.instanceId ?? '',
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId ?? '',
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1
  }
}

function makeTarget(args: {
  worktreeId: string
  top: number
  bottom: number
  contained?: boolean
}): {
  container: HTMLElement
  target: Element
  row: HTMLElement
  surface: HTMLElement
} {
  const container = document.createElement('div')
  setVerticalRect(container, 0, 1_000)
  const row = document.createElement('div')
  row.setAttribute('data-worktree-lineage-drop-id', args.worktreeId)
  const surface = document.createElement('div')
  surface.setAttribute('data-worktree-card-surface', 'true')
  const target = document.createElement('span')
  surface.appendChild(target)
  row.appendChild(surface)
  if (args.contained ?? true) {
    container.appendChild(row)
  }
  setVerticalRect(surface, args.top, args.bottom)
  return { container, target, row, surface }
}

function setVerticalRect(element: HTMLElement, top: number, bottom: number): void {
  element.getBoundingClientRect = () =>
    ({ left: 0, right: 200, top, bottom, height: bottom - top }) as DOMRect
}
