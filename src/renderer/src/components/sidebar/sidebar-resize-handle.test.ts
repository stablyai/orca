import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { WORKTREE_SIDEBAR_RESIZE_HANDLE_CLASS_NAME } from './index'

function getWorktreeSidebarScrollbarPaddingRight(): number {
  const testDir = dirname(fileURLToPath(import.meta.url))
  const css = readFileSync(resolve(testDir, '../../assets/main.css'), 'utf8')
  const block = css.match(/\.worktree-sidebar-scrollbar\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? ''
  const value = block.match(/padding-right:\s*(?<px>\d+)px/)?.groups?.px

  return value ? Number(value) : Number.NaN
}

describe('worktree sidebar resize handle', () => {
  it('keeps the hover target as wide as the right sidebar handle', () => {
    const classes = new Set(WORKTREE_SIDEBAR_RESIZE_HANDLE_CLASS_NAME.split(/\s+/))
    expect(classes.has('w-1')).toBe(true)
    expect(classes.has('w-px')).toBe(false)
  })

  it('keeps card content clear of the resize target', () => {
    expect(getWorktreeSidebarScrollbarPaddingRight()).toBeGreaterThanOrEqual(4)
  })
})
