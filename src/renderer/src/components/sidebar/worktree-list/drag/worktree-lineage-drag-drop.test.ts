// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'

import {
  getReorderUnnestRows,
  getWorktreeLineageDropTargetIdentity,
  isReorderInsideFolderRow
} from './worktree-lineage-drag-drop'

describe('getWorktreeLineageDropTargetIdentity', () => {
  it.each([true, false])(
    'keeps descendants out of the ancestor hit zone (inline content: %s)',
    (insideParentContent) => {
      const { container, target } = makeTarget({
        worktreeId: 'parent',
        top: 100,
        bottom: insideParentContent ? 300 : 200
      })
      const child = makeTarget({ worktreeId: 'child', top: 220, bottom: 300 })
      const parentContent = target.closest('[data-worktree-card-parent-content]')!
      const children = document.createElement('div')
      children.append(child.container.firstElementChild!)
      const childrenHost = insideParentContent ? parentContent : container.firstElementChild!
      childrenHost.append(children)
      const childRow = children.firstElementChild as HTMLElement
      childRow.getBoundingClientRect = () => ({ top: 220, bottom: 300 }) as DOMRect

      expect(
        getWorktreeLineageDropTargetIdentity({ container, target: child.target, pointerY: 250 })
      ).toBe('ssh:box|child')
      expect(
        getWorktreeLineageDropTargetIdentity({ container, target: childRow, pointerY: 250 })
      ).toBe('ssh:box|child')
      expect(
        getWorktreeLineageDropTargetIdentity({ container, target: children, pointerY: 250 })
      ).toBeNull()
      expect(getWorktreeLineageDropTargetIdentity({ container, target, pointerY: 120 })).toBe(
        'ssh:box|parent'
      )
    }
  )

  it('takes a folder workspace row, which joins no reorder group, as a drop parent', () => {
    const { container, target } = makeTarget({ worktreeId: 'folder:f-1', top: 100, bottom: 200 })
    const row = container.firstElementChild!
    row.removeAttribute('data-worktree-drag-id')
    row.setAttribute('data-worktree-lineage-drop-row', '')
    expect(getWorktreeLineageDropTargetIdentity({ container, target, pointerY: 150 })).toBe(
      'ssh:box|folder:f-1'
    )
  })

  it('keeps an outlined parent card a drop target', () => {
    const { container, target } = makeTarget({ worktreeId: 'parent', top: 100, bottom: 200 })
    const surface = document.createElement('div')
    surface.setAttribute('data-worktree-lineage-drop-target', 'true')
    const content = container.querySelector('[data-worktree-card-parent-content]')!
    content.replaceWith(surface)
    surface.append(content)
    expect(getWorktreeLineageDropTargetIdentity({ container, target, pointerY: 150 })).toBe(
      'ssh:box|parent'
    )
  })
})

describe('isReorderInsideFolderRow', () => {
  it('keeps a reorder inside the folder card only when the pointer and the insertion line are in it', () => {
    const folder = document.createElement('div')
    folder.setAttribute('data-worktree-lineage-drop-row', '')
    folder.setAttribute('data-worktree-host-identity', 'local|folder:f-1')
    folder.getBoundingClientRect = () => new DOMRect(0, 100, 290, 200)
    const card = document.createElement('div')
    card.setAttribute('data-worktree-card-surface', 'true')
    card.getBoundingClientRect = () => new DOMRect(15, 100, 265, 200)
    folder.append(card)
    document.body.append(folder)
    const inside = { clientX: 140, clientY: 200, lineClientY: 180 }
    expect(isReorderInsideFolderRow('local|folder:f-1', inside)).toBe(true)
    expect(isReorderInsideFolderRow('local|folder:f-1', { ...inside, clientX: 900 })).toBe(false)
    expect(isReorderInsideFolderRow('local|folder:f-1', { ...inside, clientX: 4 })).toBe(false)
    expect(isReorderInsideFolderRow('local|folder:f-1', { ...inside, lineClientY: 320 })).toBe(
      false
    )
    expect(isReorderInsideFolderRow('local|folder:f-1', { ...inside, clientY: 340 })).toBe(false)
    folder.remove()
  })
})

describe('getReorderUnnestRows', () => {
  const folderChild = { id: 'r::/w', hostId: 'ssh:box' as const }
  const groupTwin = { id: 'r::/w', hostId: 'local' as const }
  const otherGroupTwin = { id: 'r::/w', hostId: 'runtime:env' as const }
  const base = {
    legacyIds: ['r::/w'],
    pickedCopies: [folderChild, groupTwin, otherGroupTwin],
    sourceGroupIdentities: ['ssh:box|r::/w', 'local|r::/w'],
    folderParentOf: (identity: string) =>
      identity === 'ssh:box|r::/w' ? 'local|folder:f-1' : undefined
  }

  it('names a folder child and its same-group twin by host, and leaves other groups alone', () => {
    expect(getReorderUnnestRows({ ...base, keepsFolderParent: () => false })).toEqual([
      groupTwin,
      folderChild
    ])
  })

  it('keeps a folder child dropped inside its folder', () => {
    expect(getReorderUnnestRows({ ...base, keepsFolderParent: () => true })).toEqual([groupTwin])
  })

  it('leaves bare ids alone without folder children', () => {
    expect(
      getReorderUnnestRows({
        ...base,
        folderParentOf: () => undefined,
        keepsFolderParent: () => false
      })
    ).toEqual(['r::/w'])
  })
})

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
  row.setAttribute('data-worktree-host-identity', `ssh:box|${args.worktreeId}`)
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
