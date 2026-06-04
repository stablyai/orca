import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  WorktreeTitleInlineRename,
  getWorktreeTitleRenameCommit,
  isWorktreeTitleTruncated
} from './WorktreeTitleInlineRename'

describe('getWorktreeTitleRenameCommit', () => {
  it('cancels blank or unchanged inline titles', () => {
    expect(getWorktreeTitleRenameCommit('feature/login', '')).toEqual({ kind: 'cancel' })
    expect(getWorktreeTitleRenameCommit('feature/login', '   ')).toEqual({ kind: 'cancel' })
    expect(getWorktreeTitleRenameCommit('feature/login', ' feature/login ')).toEqual({
      kind: 'cancel'
    })
  })

  it('trims and saves changed inline titles', () => {
    expect(getWorktreeTitleRenameCommit('feature/login', ' Login polish ')).toEqual({
      kind: 'save',
      displayName: 'Login polish'
    })
  })
})

describe('WorktreeTitleInlineRename', () => {
  it('treats only actual text overflow as truncation', () => {
    expect(isWorktreeTitleTruncated({ clientWidth: 120, scrollWidth: 120 })).toBe(false)
    expect(isWorktreeTitleTruncated({ clientWidth: 120, scrollWidth: 119 })).toBe(false)
    expect(isWorktreeTitleTruncated({ clientWidth: 120, scrollWidth: 121 })).toBe(true)
  })

  it('renders the title as the double-click inline rename target', () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <WorktreeTitleInlineRename
          displayName="Feature workspace"
          showUnreadEmphasis
          onRename={vi.fn()}
        />
      </TooltipProvider>
    )

    expect(markup).toContain('data-worktree-title-inline-rename=""')
    expect(markup).not.toContain('cursor-text')
    expect(markup).not.toContain('title="Feature workspace"')
    expect(markup).toContain('tabindex="0"')
    expect(markup).toContain('Unread:')
    expect(markup).toContain('Feature workspace')
  })
})
