import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { BranchEntryRow } from './branch-entry-row'
import { UncommittedEntryRow } from './uncommitted-entry-row'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div data-hover-card-content>{children}</div>
  )
}))

vi.mock('./entry-context-menu', () => ({
  SourceControlEntryContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>
}))

const ROW_PATH = 'src/components/tab-bar/EditorFileTab.tsx'

/** Returns the mocked hover card's markup from rendered row markup. */
function hoverCardHtml(markup: string): string {
  const start = markup.indexOf('<div data-hover-card-content')
  expect(start).toBeGreaterThanOrEqual(0)
  return markup.slice(start)
}

describe('source control row hover card', () => {
  it('shows the file name and repo-relative path on a focusable uncommitted change row', () => {
    const markup = renderToStaticMarkup(
      <UncommittedEntryRow
        entryKey={`unstaged::${ROW_PATH}`}
        entry={{ path: ROW_PATH, status: 'modified', area: 'unstaged' }}
        currentWorktreeId="wt-1"
        worktreePath="/repo"
        onRevealInExplorer={vi.fn()}
        onOpen={vi.fn()}
        onStage={vi.fn()}
        onUnstage={vi.fn()}
        onDiscard={vi.fn()}
        commentCount={0}
      />
    )
    const card = hoverCardHtml(markup)

    expect(card).toContain('data-tab-hover-card-title="true">EditorFileTab.tsx</div>')
    expect(card).toContain(`>${ROW_PATH}</div>`)
    expect(card).not.toContain('/repo/')
    expect(card).toContain('Source Control')
    // Why: hover-only path info must also open from keyboard focus.
    expect(markup).toMatch(/<span class="[^"]*focus-visible:ring-1[^"]*" tabindex="0">/)
  })

  it('shows the file name and repo-relative path on a focusable committed branch change row', () => {
    const markup = renderToStaticMarkup(
      <BranchEntryRow
        entry={{ path: ROW_PATH, status: 'modified' }}
        currentWorktreeId="wt-1"
        worktreePath="/repo"
        onRevealInExplorer={vi.fn()}
        onOpen={vi.fn()}
        commentCount={0}
      />
    )
    const card = hoverCardHtml(markup)

    expect(card).toContain('data-tab-hover-card-title="true">EditorFileTab.tsx</div>')
    expect(card).toContain(`>${ROW_PATH}</div>`)
    expect(card).not.toContain('/repo/')
    expect(card).toContain('Source Control')
    // Why: hover-only path info must also open from keyboard focus.
    expect(markup).toMatch(/<span class="[^"]*focus-visible:ring-1[^"]*" tabindex="0">/)
  })
})
