// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { getWorktreeLineageDropTargetId } from './worktree-lineage-drag-drop'
import { getWorktreeSidebarStaticRect } from './worktree-sidebar-static-geometry'

describe('static worktree lineage hit testing', () => {
  it('keeps a tall target under the pointer when reorder preview moves it away', () => {
    const container = makeContainer({ scrollTop: 642, top: 200, bottom: 1_000 })
    const virtualRow = makeVirtualRow({ start: 1_280, top: 158 })
    const { row, surface } = makeWorktreeCard('target', {
      left: 56,
      right: 204,
      top: 158,
      bottom: 838
    })
    virtualRow.appendChild(row)
    container.appendChild(virtualRow)

    expect(getWorktreeSidebarStaticRect(container, surface)).toMatchObject({
      top: 838,
      bottom: 1_518
    })
    expect(
      getWorktreeLineageDropTargetId({
        container,
        target: container,
        pointerX: 100,
        pointerY: 883
      })
    ).toBe('target')
  })

  it('uses static intent when a shifted sibling is visually under the pointer', () => {
    const container = makeContainer({ scrollTop: 642, top: 200, bottom: 1_000 })
    const targetVirtualRow = makeVirtualRow({ start: 1_280, top: 158 })
    const target = makeWorktreeCard('target', {
      left: 56,
      right: 204,
      top: 158,
      bottom: 838
    })
    targetVirtualRow.appendChild(target.row)
    container.appendChild(targetVirtualRow)

    const siblingVirtualRow = makeVirtualRow({ start: 2_000, top: 850 })
    const sibling = makeWorktreeCard('shifted-sibling', {
      left: 56,
      right: 204,
      top: 850,
      bottom: 930
    })
    siblingVirtualRow.appendChild(sibling.row)
    container.appendChild(siblingVirtualRow)

    expect(
      getWorktreeLineageDropTargetId({
        container,
        target: sibling.surface,
        pointerX: 100,
        pointerY: 883
      })
    ).toBe('target')
  })

  it('chooses the deepest child and keeps lineage-container gaps reorderable', () => {
    const container = makeContainer({ scrollTop: 200, top: 100, bottom: 1_000 })
    const virtualRow = makeVirtualRow({ start: 600, top: 120 })
    const parent = makeWorktreeCard('parent', {
      left: 40,
      right: 220,
      top: 120,
      bottom: 520
    })
    const children = document.createElement('div')
    children.setAttribute('data-worktree-lineage-children', '')
    setRect(children, { left: 48, right: 212, top: 250, bottom: 520 })
    const child = makeWorktreeCard('child', {
      left: 56,
      right: 204,
      top: 300,
      bottom: 380
    })
    children.appendChild(child.row)
    parent.surface.appendChild(children)
    virtualRow.appendChild(parent.row)
    container.appendChild(virtualRow)

    expect(
      getWorktreeLineageDropTargetId({
        container,
        target: container,
        pointerX: 100,
        pointerY: 720
      })
    ).toBe('child')
    expect(
      getWorktreeLineageDropTargetId({
        container,
        target: container,
        pointerX: 100,
        pointerY: 650
      })
    ).toBeNull()
  })

  it('preserves reorder gutters and rejects deleting targets', () => {
    const container = makeContainer({ scrollTop: 0, top: 100, bottom: 500 })
    const { row, surface } = makeWorktreeCard('target', {
      left: 40,
      right: 220,
      top: 160,
      bottom: 260
    })
    container.appendChild(row)

    expect(
      getWorktreeLineageDropTargetId({
        container,
        target: surface,
        pointerX: 100,
        pointerY: 165
      })
    ).toBeNull()
    surface.setAttribute('aria-busy', 'true')
    expect(
      getWorktreeLineageDropTargetId({
        container,
        target: surface,
        pointerX: 100,
        pointerY: 210
      })
    ).toBeNull()
  })

  it('measures only the pointed lineage branch in a wide nested list', () => {
    let containerRectReads = 0
    let surfaceRectReads = 0
    const container = makeContainer({ scrollTop: 0, top: 0, bottom: 500 })
    setRect(container, { left: 20, right: 240, top: 0, bottom: 500 }, () => containerRectReads++)
    const virtualRow = makeVirtualRow({ start: 0, top: 0 })
    const parent = makeWorktreeCard('parent', {
      left: 40,
      right: 220,
      top: 20,
      bottom: 21_000
    })
    setRect(
      parent.surface,
      { left: 40, right: 220, top: 20, bottom: 21_000 },
      () => surfaceRectReads++
    )
    const children = document.createElement('div')
    children.setAttribute('data-worktree-lineage-children', '')
    setRect(children, { left: 48, right: 212, top: 80, bottom: 20_980 })
    for (let index = 0; index < 256; index++) {
      const top = 100 + index * 80
      const child = makeWorktreeCard(`child-${index}`, {
        left: 56,
        right: 204,
        top,
        bottom: top + 60
      })
      setRect(
        child.surface,
        { left: 56, right: 204, top, bottom: top + 60 },
        () => surfaceRectReads++
      )
      children.appendChild(child.row)
    }
    parent.surface.appendChild(children)
    virtualRow.appendChild(parent.row)
    container.appendChild(virtualRow)

    expect(
      getWorktreeLineageDropTargetId({
        container,
        target: container,
        pointerX: 100,
        pointerY: 130
      })
    ).toBe('child-0')
    expect(containerRectReads).toBe(1)
    expect(surfaceRectReads).toBeLessThanOrEqual(12)
  })

  it('targets the deepest node with reads bounded by depth and sibling width', () => {
    const depth = 8
    const siblingsPerLevel = 16
    let surfaceRectReads = 0
    const container = makeContainer({ scrollTop: 0, top: 0, bottom: 600 })
    const virtualRow = makeVirtualRow({ start: 0, top: 0 })
    const root = makeWorktreeCard('root', {
      left: 40,
      right: 220,
      top: 20,
      bottom: 3_000
    })
    setRect(root.surface, { left: 40, right: 220, top: 20, bottom: 3_000 }, () => {
      surfaceRectReads++
    })
    let branchSurface = root.surface
    let branchBottom = 3_000
    let deepestId = 'root'
    for (let level = 1; level <= depth; level++) {
      const parentSurface = branchSurface
      const children = document.createElement('div')
      children.setAttribute('data-worktree-lineage-children', '')
      setRect(children, {
        left: 48,
        right: 212,
        top: 60 + level * 4,
        bottom: branchBottom - 1
      })
      const nextBottom = branchBottom - 100
      for (let sibling = 0; sibling < siblingsPerLevel; sibling++) {
        const worktreeId = sibling === 0 ? `branch-${level}` : `decoy-${level}-${sibling}`
        const top = sibling === 0 ? 80 + level * 4 : nextBottom + sibling * 2
        const bottom = sibling === 0 ? nextBottom : top + 1
        const child = makeWorktreeCard(worktreeId, { left: 56, right: 204, top, bottom })
        setRect(child.surface, { left: 56, right: 204, top, bottom }, () => {
          surfaceRectReads++
        })
        children.appendChild(child.row)
        if (sibling === 0) {
          branchSurface = child.surface
          deepestId = worktreeId
        }
      }
      parentSurface.appendChild(children)
      branchBottom = nextBottom
    }
    virtualRow.appendChild(root.row)
    container.appendChild(virtualRow)

    expect(
      getWorktreeLineageDropTargetId({
        container,
        target: container,
        pointerX: 100,
        pointerY: 300
      })
    ).toBe(deepestId)
    const logarithmicReadsPerLevel = Math.ceil(Math.log2(siblingsPerLevel)) + 2
    expect(surfaceRectReads).toBeLessThanOrEqual(1 + depth * logarithmicReadsPerLevel)
  })

  it('descends legacy lineage after a long agent list', () => {
    const container = makeContainer({ scrollTop: 0, top: 0, bottom: 600 })
    const virtualRow = makeVirtualRow({ start: 0, top: 0 })
    const parent = makeWorktreeCard('parent', {
      left: 40,
      right: 220,
      top: 20,
      bottom: 500
    })
    const parentContent = document.createElement('div')
    parentContent.setAttribute('data-worktree-card-parent-content', '')
    const statusSlot = document.createElement('div')
    const contentColumn = document.createElement('div')
    const agentList = document.createElement('div')
    for (let index = 0; index < 128; index++) {
      agentList.appendChild(document.createElement('div'))
    }
    const legacyChildren = document.createElement('div')
    legacyChildren.setAttribute('data-worktree-legacy-lineage-children', '')
    setRect(legacyChildren, { left: 48, right: 212, top: 300, bottom: 500 })
    const child = makeWorktreeCard('child', {
      left: 56,
      right: 204,
      top: 340,
      bottom: 420
    })
    legacyChildren.appendChild(child.row)
    contentColumn.append(agentList, legacyChildren)
    parentContent.append(statusSlot, contentColumn)
    parent.surface.appendChild(parentContent)
    virtualRow.appendChild(parent.row)
    container.appendChild(virtualRow)

    expect(
      getWorktreeLineageDropTargetId({
        container,
        target: child.surface,
        pointerX: 100,
        pointerY: 380
      })
    ).toBe('child')
  })

  it('does not hit shifted cards through chrome outside the scroller', () => {
    const container = makeContainer({ scrollTop: 642, top: 200, bottom: 1_000 })
    const virtualRow = makeVirtualRow({ start: 1_280, top: 158 })
    const { row } = makeWorktreeCard('target', {
      left: 56,
      right: 204,
      top: 158,
      bottom: 838
    })
    virtualRow.appendChild(row)
    container.appendChild(virtualRow)

    expect(
      getWorktreeLineageDropTargetId({
        container,
        target: container,
        pointerX: 100,
        pointerY: 165
      })
    ).toBeNull()
  })

  it('does not hit static cards through an active sticky header', () => {
    const container = makeContainer({ scrollTop: 642, top: 200, bottom: 1_000 })
    const virtualRow = makeVirtualRow({ start: 1_280, top: 158 })
    const { row } = makeWorktreeCard('target', {
      left: 56,
      right: 204,
      top: 158,
      bottom: 838
    })
    virtualRow.appendChild(row)
    container.appendChild(virtualRow)
    const stickyHeader = document.createElement('div')
    stickyHeader.setAttribute('data-worktree-sticky-header-active', '')
    container.appendChild(stickyHeader)

    expect(
      getWorktreeLineageDropTargetId({
        container,
        target: stickyHeader,
        pointerX: 100,
        pointerY: 883
      })
    ).toBeNull()
  })
})

function makeContainer(args: { scrollTop: number; top: number; bottom: number }): HTMLElement {
  const container = document.createElement('div')
  container.scrollTop = args.scrollTop
  setRect(container, { left: 20, right: 240, top: args.top, bottom: args.bottom })
  return container
}

function makeVirtualRow(args: { start: number; top: number }): HTMLElement {
  const row = document.createElement('div')
  row.setAttribute('data-worktree-virtual-row', '')
  row.setAttribute('data-worktree-virtual-row-start', String(args.start))
  setRect(row, { left: 20, right: 240, top: args.top, bottom: args.top + 680 })
  return row
}

function makeWorktreeCard(
  worktreeId: string,
  rect: { left: number; right: number; top: number; bottom: number }
): { row: HTMLElement; surface: HTMLElement } {
  const row = document.createElement('div')
  row.setAttribute('data-worktree-lineage-drop-id', worktreeId)
  const surface = document.createElement('div')
  surface.setAttribute('data-worktree-card-surface', 'true')
  setRect(surface, rect)
  row.appendChild(surface)
  return { row, surface }
}

function setRect(
  element: HTMLElement,
  rect: { left: number; right: number; top: number; bottom: number },
  onRead?: () => void
): void {
  element.getBoundingClientRect = () => {
    onRead?.()
    return {
      ...rect,
      height: rect.bottom - rect.top,
      width: rect.right - rect.left
    } as DOMRect
  }
}
