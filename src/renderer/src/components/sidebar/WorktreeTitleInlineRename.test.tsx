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
    expect(markup).toContain('font-semibold text-foreground')
    expect(markup).toContain('Unread:')
    expect(markup).toContain('Feature workspace')
  })

  it('keeps read titles at the default foreground color unless requested', () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <WorktreeTitleInlineRename displayName="Feature workspace" onRename={vi.fn()} />
      </TooltipProvider>
    )

    expect(markup).toContain('font-normal text-foreground')
    expect(markup).not.toContain('text-foreground/80')
    expect(markup).not.toContain('Unread:')
  })

  it('dims read titles when requested by the experimental card style', () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <WorktreeTitleInlineRename
          displayName="Feature workspace"
          dimReadTitle
          onRename={vi.fn()}
        />
      </TooltipProvider>
    )

    expect(markup).toContain('font-normal text-foreground/80')
    expect(markup).not.toContain('Unread:')
  })
})
