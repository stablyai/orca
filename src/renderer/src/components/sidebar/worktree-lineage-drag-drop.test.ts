// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getCyclicProjectedWorktreeLineageIds } from './worktree-lineage-projection'
import {
  getReorderedWorktreeIdsToUnnest,
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

  it('ignores content targets outside the sidebar container', () => {
    const { container, target } = makeTarget({
      worktreeId: 'parent',
      top: 100,
      bottom: 200,
      contained: false
    })

    expect(getWorktreeLineageDropTargetId({ container, target, pointerY: 150 })).toBeNull()
  })

  it.each(['status', 'agent'] as const)(
    'keeps the %s region in the lineage nesting hit zone',
    (targetRole) => {
      const { container, target } = makeTarget({
        worktreeId: 'parent',
        top: 100,
        bottom: 200,
        targetRole
      })

      expect(getWorktreeLineageDropTargetId({ container, target, pointerY: 150 })).toBe('parent')
    }
  )
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
  targetRole?: 'identity' | 'status' | 'agent'
}): {
  container: HTMLElement
  target: Element
} {
  const container = document.createElement('div')
  const row = document.createElement('div')
  row.setAttribute('data-worktree-drag-id', args.worktreeId)
  const content = document.createElement('div')
  content.setAttribute('data-worktree-card-parent-content', '')
  content.getBoundingClientRect = () => ({ top: args.top, bottom: args.bottom }) as DOMRect
  const status = document.createElement('div')
  const identity = document.createElement('div')
  identity.setAttribute('data-worktree-card-hover-trigger', '')
  const agent = document.createElement('div')
  content.append(status, identity, agent)
  row.append(content)
  container.append(row)

  const targetByRole = { status, identity, agent }
  const target = targetByRole[args.targetRole ?? 'identity']
  const contained = args.contained ?? true
  if (!contained) {
    container.removeChild(row)
  }
  return { container, target }
}
