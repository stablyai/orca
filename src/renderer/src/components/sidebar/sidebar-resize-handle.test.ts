import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WORKTREE_SIDEBAR_RESIZE_HANDLE_CLASS_NAME } from './index'

function getWorktreeSidebarScrollbarPaddingRight(): number {
  const testDir = import.meta.dirname
  const css = readFileSync(resolve(testDir, '../../assets/main.css'), 'utf8')
  const block = css.match(/\.worktree-sidebar-scrollbar\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? ''
  const value = block.match(/padding-right:\s*(?<px>\d+)px/)?.groups?.px

  return value ? Number(value) : Number.NaN
}

describe('worktree sidebar resize handle', () => {
  it('keeps a wide hit target that straddles the sidebar seam', () => {
    const classes = new Set(WORKTREE_SIDEBAR_RESIZE_HANDLE_CLASS_NAME.split(/\s+/))
    expect(classes.has('w-3')).toBe(true)
    expect(classes.has('-right-1.5')).toBe(true)
    expect(classes.has('w-px')).toBe(false)
  })

  it('keeps card content clear of the resize target', () => {
    expect(getWorktreeSidebarScrollbarPaddingRight()).toBeGreaterThanOrEqual(4)
  })
})
