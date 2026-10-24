import { describe, expect, it } from 'vitest'
import { worktreeSidebarResizeHandleClassName } from './index'

describe('worktree sidebar resize handle', () => {
  it('straddles the seam facing the center pane on either edge', () => {
    const left = new Set(worktreeSidebarResizeHandleClassName('left').split(/\s+/))
    expect(left.has('-right-1.5')).toBe(true)
    expect(left.has('-left-1.5')).toBe(false)

    const right = new Set(worktreeSidebarResizeHandleClassName('right').split(/\s+/))
    expect(right.has('-left-1.5')).toBe(true)
    expect(right.has('-right-1.5')).toBe(false)
  })
})
