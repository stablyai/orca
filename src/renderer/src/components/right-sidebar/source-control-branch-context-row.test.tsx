import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { SourceControlBranchContextRow } from './source-control-branch-context-row'
import type { GitBranchCompareSummary } from '../../../../shared/types'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

const readySummary: GitBranchCompareSummary = {
  baseRef: 'refs/remotes/origin/FRONT-192-ZisVoucherStrip',
  baseOid: 'base',
  compareRef: 'feature',
  headOid: 'head',
  mergeBase: 'base',
  changedFiles: 0,
  commitsAhead: 0,
  status: 'ready'
}

describe('SourceControlBranchContextRow', () => {
  it('lets the base ref use the full available header width', () => {
    const markup = renderToStaticMarkup(
      <SourceControlBranchContextRow
        summary={readySummary}
        compareBaseRef={null}
        onChangeBaseRef={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    // Display drops refs/remotes/; full ref stays in the title attribute.
    expect(markup).toContain('origin/FRONT-192-ZisVoucherStrip')
    expect(markup).toContain('refs/remotes/origin/FRONT-192-ZisVoucherStrip')
    expect(markup).toContain('max-w-full')
    expect(markup).toContain('min-w-0 flex-1')
  })

  it('stacks head above → base so both keep full row width', () => {
    const markup = renderToStaticMarkup(
      <SourceControlBranchContextRow
        summary={readySummary}
        compareBaseRef={null}
        headDisplay={{ kind: 'branch', branchName: 'fix-fork-pr-fetch-head-race' }}
        onChangeBaseRef={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    const headIndex = markup.indexOf('fix-fork-pr-fetch-head-race')
    const arrowIndex = markup.indexOf('→')
    const baseIndex = markup.indexOf('origin/FRONT-192-ZisVoucherStrip')
    expect(headIndex).toBeGreaterThan(-1)
    expect(arrowIndex).toBeGreaterThan(headIndex)
    expect(baseIndex).toBeGreaterThan(arrowIndex)
    // Stacked column, not a single-line head→base pair.
    expect(markup).toContain('flex-col')
    expect(markup).not.toContain('>vs<')
    expect(markup).toContain(
      'aria-label="fix-fork-pr-fetch-head-race → origin/FRONT-192-ZisVoucherStrip"'
    )
  })

  it('falls back to "vs base" when head identity is missing', () => {
    const markup = renderToStaticMarkup(
      <SourceControlBranchContextRow
        summary={readySummary}
        compareBaseRef={null}
        onChangeBaseRef={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    expect(markup).toContain('>vs<')
    expect(markup).toContain('origin/FRONT-192-ZisVoucherStrip')
    expect(markup).not.toContain('→')
  })

  it('shows head-only identity when there is no compare base', () => {
    const markup = renderToStaticMarkup(
      <SourceControlBranchContextRow
        summary={null}
        compareBaseRef={null}
        headDisplay={{ kind: 'branch', branchName: 'local-only-branch' }}
        onChangeBaseRef={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    expect(markup).toContain('data-testid="source-control-head-identity"')
    expect(markup).toContain('local-only-branch')
    expect(markup).toContain('aria-label="Current branch: local-only-branch"')
    expect(markup).toContain('tabindex="0"')
    expect(markup).not.toContain('→')
    expect(markup).not.toContain('>vs<')
  })

  it('marks the loading path busy and announces comparing', () => {
    const markup = renderToStaticMarkup(
      <SourceControlBranchContextRow
        summary={{ ...readySummary, status: 'loading' }}
        compareBaseRef={null}
        headDisplay={{ kind: 'branch', branchName: 'loading-branch' }}
        onChangeBaseRef={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('Comparing against')
    expect(markup).toContain('aria-label="loading-branch → origin/FRONT-192-ZisVoucherStrip"')
  })

  it('shows detached head-only identity when there is no compare base', () => {
    const markup = renderToStaticMarkup(
      <SourceControlBranchContextRow
        summary={null}
        compareBaseRef={null}
        headDisplay={{
          kind: 'detached',
          shortHead: '8cec248',
          sidebarLabel: 'Detached HEAD @ 8cec248',
          sourceControlLabel: 'Detached HEAD · 8cec248',
          tooltip: 'Detached HEAD at 8cec248. You are viewing a commit, not a branch.'
        }}
        onChangeBaseRef={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    expect(markup).toContain('Detached HEAD · 8cec248')
    expect(markup).toContain('tabindex="0"')
    expect(markup).not.toContain('→')
    expect(markup).not.toContain('>vs<')
  })

  it('renders nothing when neither base nor head identity is available', () => {
    const markup = renderToStaticMarkup(
      <SourceControlBranchContextRow
        summary={null}
        compareBaseRef={null}
        onChangeBaseRef={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    expect(markup).toBe('')
  })

  it('renders detached HEAD identity above the base with keyboard-reachable badge', () => {
    const markup = renderToStaticMarkup(
      <SourceControlBranchContextRow
        summary={readySummary}
        compareBaseRef={null}
        headDisplay={{
          kind: 'detached',
          shortHead: '8cec248',
          sidebarLabel: 'Detached HEAD @ 8cec248',
          sourceControlLabel: 'Detached HEAD · 8cec248',
          tooltip: 'Detached HEAD at 8cec248. You are viewing a commit, not a branch.'
        }}
        onChangeBaseRef={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    const headIndex = markup.indexOf('Detached HEAD · 8cec248')
    const baseIndex = markup.indexOf('origin/FRONT-192-ZisVoucherStrip')
    expect(headIndex).toBeGreaterThan(-1)
    expect(baseIndex).toBeGreaterThan(headIndex)
    expect(markup).toContain(
      'aria-label="Detached HEAD at 8cec248. You are viewing a commit, not a branch."'
    )
    expect(markup).toContain('tabindex="0"')
    expect(markup).toContain(
      'aria-label="Detached HEAD · 8cec248 → origin/FRONT-192-ZisVoucherStrip"'
    )
  })

  it('keeps the head→base label on the error path', () => {
    const markup = renderToStaticMarkup(
      <SourceControlBranchContextRow
        summary={{
          ...readySummary,
          status: 'error',
          errorMessage: 'Could not compare against base'
        }}
        compareBaseRef={null}
        headDisplay={{ kind: 'branch', branchName: 'feature/retry-me' }}
        onChangeBaseRef={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    expect(markup).toContain('role="group"')
    expect(markup).toContain('aria-label="feature/retry-me → origin/FRONT-192-ZisVoucherStrip"')
    expect(markup).toContain('Could not compare against base')
    expect(markup).toContain('Retry')
  })

  it('renders a compact external review link when a manual URL is available', () => {
    const markup = renderToStaticMarkup(
      <SourceControlBranchContextRow
        summary={readySummary}
        compareBaseRef={null}
        manualReviewUrl="https://github.com/stablyai/orca/compare/main...feature?expand=1"
        onChangeBaseRef={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    expect(markup).toContain('aria-label="Open review page in browser"')
  })
})
