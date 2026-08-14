import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const storeState: {
  gitStatusByWorktree?: Record<string, unknown[]>
  gitStatusHugeByWorktree?: Record<string, { limit: number }>
} = {}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(storeState)
}))

const { WorktreeCardChangeCountBadge } = await import('./WorktreeCardChangeCountBadge')
const { TooltipProvider } = await import('@/components/ui/tooltip')

function render(worktreeId: string): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <WorktreeCardChangeCountBadge worktreeId={worktreeId} />
    </TooltipProvider>
  )
}

describe('WorktreeCardChangeCountBadge', () => {
  beforeEach(() => {
    delete storeState.gitStatusByWorktree
    delete storeState.gitStatusHugeByWorktree
  })

  it('renders nothing for a clean workspace', () => {
    storeState.gitStatusByWorktree = { 'repo::/clean': [] }

    expect(render('repo::/clean')).toBe('')
  })

  it('renders nothing when status has not loaded', () => {
    storeState.gitStatusByWorktree = {}

    expect(render('repo::/unknown')).toBe('')
  })

  it('renders nothing when the status slice is absent', () => {
    // Why: sidebar rows render under partial store mocks that never populate it.
    expect(render('repo::/unknown')).toBe('')
  })

  it('shows the count and a singular label for one change', () => {
    storeState.gitStatusByWorktree = { 'repo::/dirty': [{}] }

    const html = render('repo::/dirty')

    expect(html).toContain('>1<')
    expect(html).toContain('1 uncommitted change')
    expect(html).not.toContain('uncommitted changes')
  })

  it('presents a capped count as a floor, not a total', () => {
    // Why: git was stopped at the cap, so the real number is unknown. Showing a
    // bare 1000 would contradict Source Control's own "too many changes" state.
    storeState.gitStatusByWorktree = { 'repo::/huge': Array.from({ length: 1000 }, () => ({})) }
    storeState.gitStatusHugeByWorktree = { 'repo::/huge': { limit: 1000 } }

    const html = render('repo::/huge')

    expect(html).toContain('1000+')
    expect(html).toContain('At least 1000 uncommitted changes')
    expect(html).not.toContain('>1000 uncommitted changes')
  })

  it('shows the count and a plural label for several changes', () => {
    storeState.gitStatusByWorktree = { 'repo::/dirty': [{}, {}, {}] }

    const html = render('repo::/dirty')

    expect(html).toContain('>3<')
    expect(html).toContain('3 uncommitted changes')
  })

  it('carries no tooltip of its own', () => {
    // Why: every card style wraps this row in the details hover, whose
    // "Uncommitted Changes" section states the same total and breaks it down. A
    // tooltip here opens on top of that section and covers its heading -- seen in
    // the running app, not in a unit test. Radix marks its trigger with
    // data-state, so its absence is what proves the badge is a plain span.
    storeState.gitStatusByWorktree = { 'repo::/dirty': [{}, {}, {}] }

    const html = render('repo::/dirty')

    expect(html).not.toContain('data-state=')
    expect(html.match(/3 uncommitted changes/g)).toHaveLength(1)
  })
})
