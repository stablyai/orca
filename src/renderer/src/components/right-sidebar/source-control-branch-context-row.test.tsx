import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { SourceControlBranchContextRow } from './source-control/panel/branch-context-row'
import type { GitBranchCompareSummary } from '../../../../shared/git-diff-compare-types'
import type { GitBranchLineTotal } from '../../../../shared/git-status-types'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/hover-card', () => ({
  HoverCard: ({ children }: { children: ReactNode }) => <>{children}</>,
  HoverCardContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  HoverCardTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
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

  // A branch rebased onto origin/main still tracks its pre-rebase remote branch,
  // so upstream ↑↓ answered a question nobody asked here. One count, against the
  // base ref, on the line that names it.
  it('counts commits against the compare base, on the base line', () => {
    const markup = renderToStaticMarkup(
      <SourceControlBranchContextRow
        summary={{ ...readySummary, baseRef: 'refs/remotes/origin/main', commitsAhead: 5 }}
        compareBaseRef={null}
        headDisplay={{ kind: 'branch', branchName: 'feature/rebased' }}
        onChangeBaseRef={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    // Anchor on the base-ref button, not on 'origin/main' — the group's
    // head→base aria-label repeats the base ref at the top of the markup.
    const baseIndex = markup.indexOf('aria-label="Change base ref:')
    expect(markup.indexOf('↑5')).toBeGreaterThan(baseIndex)
    expect(markup).toContain('aria-label="5 commits ahead of origin/main"')
    // Nothing claims the branch is behind — that count is not available.
    expect(markup).not.toContain('↓')
  })

  it('shows the count on the base line when there is no head identity', () => {
    const markup = renderToStaticMarkup(
      <SourceControlBranchContextRow
        summary={{ ...readySummary, commitsAhead: 3 }}
        compareBaseRef={null}
        headDisplay={null}
        onChangeBaseRef={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    expect(markup).toContain('↑3')
    expect(markup).toContain('aria-label="3 commits ahead of origin/FRONT-192-ZisVoucherStrip"')
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
    expect(markup).toContain('aria-label="8259 lines added, 670 lines deleted"')
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
    expect(addedOnly).toContain('aria-label="42 lines added"')

    const removedOnly = renderWithLineTotal({ added: 0, removed: 7, mergeBase: 'base' })
    expect(removedOnly).toContain('>-7<')
    expect(removedOnly).not.toContain('>+0<')
    expect(removedOnly).toContain('aria-label="7 lines deleted"')
  })

  it('hides the chip when both counts are zero', () => {
    const markup = renderWithLineTotal({ added: 0, removed: 0, mergeBase: 'base' })

    expect(markup).not.toContain('data-testid="source-control-branch-line-total"')
    expect(markup).not.toContain('>+0<')
    expect(markup).not.toContain('>-0<')
  })

  it('renders nothing at all when the total is absent', () => {
    // Why: a null total is equally "still computing" and "this host will never
    // send one", so there is no placeholder to show — the slot stays empty.
    for (const total of [null, undefined]) {
      const markup = renderWithLineTotal(total)
      expect(markup).not.toContain('data-testid="source-control-branch-line-total"')
      expect(markup).not.toContain('animate-pulse')
      expect(markup).not.toContain('NaN')
    }
  })

  // Regression: with no upstream divergence this is the only count left, so
  // dropping it left a pushed, rebased branch showing no divergence at all.
  it('counts commits against the compare base on the base line', () => {
    const markup = renderWithLineTotal(
      { added: 8259, removed: 670, mergeBase: 'base' },
      { ...readySummary, commitsAhead: 2 }
    )

    expect(markup).toContain('↑2')
    expect(markup).toContain('2 commits ahead of origin/FRONT-192-ZisVoucherStrip')
    // It belongs to the base line, after the base-ref button.
    expect(markup.indexOf('↑2')).toBeGreaterThan(markup.indexOf('aria-label="Change base ref:'))
    // Nothing claims the branch is behind its base — that count does not exist.
    expect(markup).not.toContain('↓')
  })

  it('keeps the commit count out of the line-total colors', () => {
    const markup = renderToStaticMarkup(
      <SourceControlBranchContextRow
        summary={{ ...readySummary, commitsAhead: 2 }}
        compareBaseRef={null}
        headDisplay={{ kind: 'branch', branchName: 'feature/line-total' }}
        branchLineTotal={{ added: 8259, removed: 670, mergeBase: 'base' }}
        onChangeBaseRef={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    // Two adjacent green numbers counting different units is the bug this guards.
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

// The hover-card mock at the top renders content inline, so these assert the
// breakdown copy without driving a real hover.
describe('SourceControlBranchContextRow line total test split', () => {
  it('breaks the panel down into test and non-test halves', () => {
    const markup = renderWithLineTotal({
      added: 243,
      removed: 149,
      mergeBase: 'base',
      test: { added: 120, removed: 40 }
    })

    expect(markup).toContain('Code breakdown')
    expect(markup).toContain('Lines of code')
    expect(markup).toContain('data-testid="source-control-branch-line-total-breakdown"')
    expect(markup).toContain('Non-test')
    expect(markup).toContain('>+123<')
    expect(markup).toContain('>-109<')
    expect(markup).toContain('Tests')
    expect(markup).toContain('>+120<')
    expect(markup).toContain('>-40<')
    // Non-test first so the primary share leads the panel.
    expect(markup.indexOf('Non-test')).toBeLessThan(markup.indexOf('Tests'))
  })

  it('spells the split into the label so the summary is announced closed', () => {
    const markup = renderWithLineTotal({
      added: 243,
      removed: 149,
      mergeBase: 'base',
      test: { added: 120, removed: 40 }
    })

    expect(markup).toContain(
      'aria-label="243 lines added, 149 lines deleted — test code: 120 lines added, 40 lines deleted"'
    )
  })

  it('keeps a zero test share visible rather than hiding the row', () => {
    const markup = renderWithLineTotal({
      added: 243,
      removed: 149,
      mergeBase: 'base',
      test: { added: 0, removed: 0 }
    })

    expect(markup).toContain('>+0<')
    expect(markup).toContain('>-0<')
    expect(markup).toContain('>+243<')
    expect(markup).toContain('>-149<')
    // Panel keeps the zero row; the spoken label stays the main totals only.
    expect(markup).toContain('aria-label="243 lines added, 149 lines deleted"')
    expect(markup).not.toContain('test code:')
  })

  // A host predating the split omits the field; inventing a 0% test share there
  // would be a confidently wrong claim.
  it('renders exactly as before when the host reported no split', () => {
    const withoutSplit = renderWithLineTotal({ added: 243, removed: 149, mergeBase: 'base' })

    expect(withoutSplit).not.toContain('Non-test')
    expect(withoutSplit).not.toContain('Code breakdown')
    expect(withoutSplit).toContain('aria-label="243 lines added, 149 lines deleted"')
  })

  it('labels the remainder Source once generated is known, and shows that row', () => {
    const markup = renderWithLineTotal({
      added: 243,
      removed: 149,
      mergeBase: 'base',
      test: { added: 20, removed: 10 },
      generated: { added: 100, removed: 50 }
    })

    expect(markup).toContain('Source')
    expect(markup).not.toContain('Non-test')
    expect(markup).toContain('Generated')
    expect(markup).toContain('>+123<') // 243-20-100
    expect(markup).toContain('>-89<') // 149-10-50
    expect(markup).toContain('>+100<')
    expect(markup).toContain('>-50<')
    expect(markup).toContain(
      'aria-label="243 lines added, 149 lines deleted — test code: 20 lines added, 10 lines deleted — generated: 100 lines added, 50 lines deleted"'
    )
  })

  // The remainder here still contains tests, so calling it "Source" would claim
  // a split the host never sent.
  it('labels the remainder Non-generated when the host omitted the test field', () => {
    const markup = renderWithLineTotal({
      added: 243,
      removed: 149,
      mergeBase: 'base',
      generated: { added: 100, removed: 50 }
    })

    expect(markup).toContain('Non-generated')
    expect(markup).toContain('>Generated<')
    expect(markup).not.toContain('>Source<')
    expect(markup).not.toContain('Tests')
    expect(markup).toContain('>+143<') // 243-100
    expect(markup).toContain('>-99<') // 149-50
  })

  // "No tests in this branch" is worth stating; "nothing was generated" is the
  // normal case, so that row is dropped rather than shown as +0 -0.
  it('drops the generated row and its announcement when nothing was generated', () => {
    const markup = renderWithLineTotal({
      added: 243,
      removed: 149,
      mergeBase: 'base',
      test: { added: 120, removed: 40 },
      generated: { added: 0, removed: 0 }
    })

    expect(markup).not.toContain('Generated')
    expect(markup).not.toContain('generated:')
    // The host did classify and found nothing, so the remainder is still Source.
    expect(markup).toContain('Source')
    expect(markup).toContain('Tests')
    expect(markup).toContain('>+123<')
  })

  it('orders the rows source, tests, generated', () => {
    const markup = renderWithLineTotal({
      added: 1243,
      removed: 149,
      mergeBase: 'base',
      test: { added: 120, removed: 40 },
      generated: { added: 1000, removed: 0 }
    })

    expect(markup.indexOf('Source')).toBeLessThan(markup.indexOf('Tests'))
    expect(markup.indexOf('Tests')).toBeLessThan(markup.indexOf('Generated'))
    expect(markup).toContain('>+1,000<')
  })

  // The three rows must account for every line, or the panel contradicts the chip.
  it('keeps the three rows summing back to the chip total', () => {
    const markup = renderWithLineTotal({
      added: 500,
      removed: 200,
      mergeBase: 'base',
      test: { added: 150, removed: 60 },
      generated: { added: 300, removed: 100 }
    })

    expect(markup).toContain('>+50<') // 500-150-300
    expect(markup).toContain('>-40<') // 200-60-100
    expect(markup).toContain('>+150<')
    expect(markup).toContain('>+300<')
  })
})
