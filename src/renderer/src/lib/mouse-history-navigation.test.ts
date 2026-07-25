// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  WORKTREE_SIDEBAR_SURFACE_ATTRIBUTE,
  isWorktreeSidebarSurfaceTarget,
  mouseHistoryDirection
} from './mouse-history-navigation'

describe('mouseHistoryDirection', () => {
  it('maps the X1/X2 thumb buttons to history directions', () => {
    expect(mouseHistoryDirection(3)).toBe('back')
    expect(mouseHistoryDirection(4)).toBe('forward')
  })

  it('ignores primary, middle, and secondary buttons', () => {
    expect(mouseHistoryDirection(0)).toBeNull()
    expect(mouseHistoryDirection(1)).toBeNull()
    expect(mouseHistoryDirection(2)).toBeNull()
  })
})

describe('isWorktreeSidebarSurfaceTarget', () => {
  it('detects targets inside the marked worktree sidebar', () => {
    const sidebar = document.createElement('div')
    sidebar.setAttribute(WORKTREE_SIDEBAR_SURFACE_ATTRIBUTE, '')
    const child = document.createElement('button')
    sidebar.appendChild(child)
    document.body.appendChild(sidebar)

    expect(isWorktreeSidebarSurfaceTarget(child)).toBe(true)
    expect(isWorktreeSidebarSurfaceTarget(sidebar)).toBe(true)

    sidebar.remove()
  })

  it('rejects targets outside the sidebar and non-element targets', () => {
    const outside = document.createElement('div')
    document.body.appendChild(outside)

    expect(isWorktreeSidebarSurfaceTarget(outside)).toBe(false)
    expect(isWorktreeSidebarSurfaceTarget(null)).toBe(false)
    expect(isWorktreeSidebarSurfaceTarget(document)).toBe(false)

    outside.remove()
  })
})
