import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { SourceControlBranchContextRow } from './source-control-branch-context-row'
import type { GitBranchCompareSummary } from '../../../../shared/types'
import type { GitBranchLineTotal } from '../../../../shared/git-status-types'

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

function renderWithLineTotal(
  branchLineTotal: GitBranchLineTotal | null | undefined,
  summary: GitBranchCompareSummary | null = readySummary
): string {
  return renderToStaticMarkup(
    <SourceControlBranchContextRow
      summary={summary}
      compareBaseRef={null}
      headDisplay={{ kind: 'branch', branchName: 'feature/line-total' }}
      manualReviewUrl="https://example.test/review"
      branchLineTotal={branchLineTotal}
      onChangeBaseRef={vi.fn()}
      onRetry={vi.fn()}
    />
  )
}

describe('SourceControlBranchContextRow branch line total', () => {
  it('renders both halves with grouped digits and a spoken label', () => {
    const markup = renderWithLineTotal({ added: 8259, removed: 670, mergeBase: 'base' })

    expect(markup).toContain('+8,259')
    expect(markup).toContain('-670')
    // Label reads raw digits; the grouped spans are decoration.
    expect(markup).toContain('aria-label="8259 additions, 670 deletions"')
    expect(markup).toContain('tabular-nums')
    expect(markup).toContain('text-[color:var(--git-decoration-added)]')
    expect(markup).toContain('text-[color:var(--git-decoration-deleted)]')
    // Not clickable in v1 — the chip's scope differs from openBranchAllDiffs.
    expect(markup).not.toContain('<button type="button" data-testid="source-control-branch')
  })

  // `truncate` clips nothing on an inline box, so an inline head identity let a
  // long branch name overflow its flex item and run under the chip.
  it('gives the head identity a block box so long names ellipsize instead of overlapping', () => {
    const markup = renderToStaticMarkup(
      <SourceControlBranchContextRow
        summary={readySummary}
        compareBaseRef={null}
        headDisplay={{
          kind: 'branch',
          branchName: 'refactor-remove-legacy-gemini-cli-current-model-plumbing'
        }}
        branchLineTotal={{ added: 16, removed: 1541, mergeBase: 'base' }}
        onChangeBaseRef={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    const identityClasses =
      /class="([^"]*)"[^>]*data-testid="source-control-head-identity"/.exec(markup)?.[1] ?? ''

    expect(identityClasses).toContain('block')
    expect(identityClasses).toContain('truncate')
    expect(identityClasses).toContain('min-w-0')
  })

  it('keeps full precision instead of a compact 8.3k form', () => {
    const markup = renderWithLineTotal({ added: 123456, removed: 0, mergeBase: 'base' })

    expect(markup).toContain(`+${(123456).toLocaleString()}`)
    expect(markup).not.toContain('123k')
    expect(markup).not.toContain('123.5')
  })

  it('omits the zero half rather than printing +42 -0', () => {
    const addedOnly = renderWithLineTotal({ added: 42, removed: 0, mergeBase: 'base' })
    expect(addedOnly).toContain('>+42<')
    expect(addedOnly).not.toContain('>-0<')
    expect(addedOnly).toContain('aria-label="42 additions"')

    const removedOnly = renderWithLineTotal({ added: 0, removed: 7, mergeBase: 'base' })
    expect(removedOnly).toContain('>-7<')
    expect(removedOnly).not.toContain('>+0<')
    expect(removedOnly).toContain('aria-label="7 deletions"')
  })

  it('hides the chip when both counts are zero', () => {
    const markup = renderWithLineTotal({ added: 0, removed: 0, mergeBase: 'base' })

    expect(markup).not.toContain('data-testid="source-control-branch-line-total"')
    expect(markup).not.toContain('>+0<')
    expect(markup).not.toContain('>-0<')
  })

  it('hides the chip when the total is absent', () => {
    for (const total of [null, undefined]) {
      const markup = renderWithLineTotal(total)
      expect(markup).not.toContain('data-testid="source-control-branch-line-total"')
      expect(markup).not.toContain('NaN')
    }
  })

  // Lines measure the branch's work, commits measure the comparison, so each sits
  // on the line that names its subject. Adjacency is what made them read as one
  // number in the first place.
  it('puts the chip on the head line, ahead of the base line and its commit count', () => {
    const markup = renderWithLineTotal(
      { added: 8259, removed: 670, mergeBase: 'base' },
      {
        ...readySummary,
        commitsAhead: 2
      }
    )
    const headIndex = markup.indexOf('data-testid="source-control-head-identity"')
    const chipIndex = markup.indexOf('data-testid="source-control-branch-line-total"')
    const aheadIndex = markup.indexOf('↑2')
    const reviewIndex = markup.indexOf('aria-label="Open review page in browser"')

    expect(headIndex).toBeGreaterThan(-1)
    expect(chipIndex).toBeGreaterThan(headIndex)
    expect(aheadIndex).toBeGreaterThan(chipIndex)
    expect(reviewIndex).toBeGreaterThan(aheadIndex)
  })

  it('keeps the ahead count out of the line-total colors', () => {
    const markup = renderWithLineTotal(
      { added: 8259, removed: 670, mergeBase: 'base' },
      { ...readySummary, commitsAhead: 2 }
    )
    // The `↑2` span must carry the muted class, not added-green — two adjacent
    // green numbers counting different units is the bug this guards.
    const aheadSpan = markup.slice(
      markup.lastIndexOf('<span', markup.indexOf('↑2')),
      markup.indexOf('↑2')
    )

    expect(aheadSpan).toContain('text-muted-foreground/70')
    expect(aheadSpan).not.toContain('--git-decoration-added')
  })

  it('folds the chip onto the base line when there is no head identity', () => {
    const markup = renderToStaticMarkup(
      <SourceControlBranchContextRow
        summary={readySummary}
        compareBaseRef={null}
        headDisplay={null}
        branchLineTotal={{ added: 8259, removed: 670, mergeBase: 'base' }}
        onChangeBaseRef={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    expect(markup).toContain('data-testid="source-control-branch-line-total"')
    expect(markup).toContain('+8,259')
  })

  it('stays hidden while compare is loading or failed', () => {
    const total: GitBranchLineTotal = { added: 8259, removed: 670, mergeBase: 'base' }

    for (const summary of [
      null,
      { ...readySummary, status: 'loading' } as GitBranchCompareSummary,
      {
        ...readySummary,
        status: 'error',
        errorMessage: 'Could not compare against base'
      } as GitBranchCompareSummary
    ]) {
      const markup = renderWithLineTotal(total, summary)
      expect(markup).not.toContain('data-testid="source-control-branch-line-total"')
      expect(markup).not.toContain('+8,259')
    }
  })
})
