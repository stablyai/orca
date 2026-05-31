import { describe, expect, it } from 'vitest'
import { WORKTREE_SIDEBAR_RESIZE_HANDLE_CLASS_NAME } from './index'

describe('worktree sidebar resize handle', () => {
  it('keeps the hover target as wide as the right sidebar handle', () => {
    const classes = new Set(WORKTREE_SIDEBAR_RESIZE_HANDLE_CLASS_NAME.split(/\s+/))
    expect(classes.has('w-1')).toBe(true)
    expect(classes.has('w-px')).toBe(false)
  })
})
