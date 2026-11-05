// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'

import { getWorktreeLineageDropTargetId } from './worktree-lineage-drag-drop'

describe('getWorktreeLineageDropTargetId', () => {
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
        getWorktreeLineageDropTargetId({ container, target: child.target, pointerY: 250 })
      ).toBe('child')
      expect(getWorktreeLineageDropTargetId({ container, target: childRow, pointerY: 250 })).toBe(
        'child'
      )
      expect(
        getWorktreeLineageDropTargetId({ container, target: children, pointerY: 250 })
      ).toBeNull()
      expect(getWorktreeLineageDropTargetId({ container, target, pointerY: 120 })).toBe('parent')
    }
  )
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
