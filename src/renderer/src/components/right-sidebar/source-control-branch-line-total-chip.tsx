import React, { useMemo } from 'react'
import type { GitBranchLineTotal } from '../../../../shared/git-status-types'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { getIntlLocale, translate } from '@/i18n/i18n'

// Why: raw digits, not the grouped display string — screen readers announce
// "8,259" as two numbers in several locales.
function buildAccessibleLabel(added: number, removed: number): string {
  if (added > 0 && removed > 0) {
    return translate(
      'auto.components.right.sidebar.source.control.branch.line.total.chip.daa8e8e59b',
      '{{value0}} lines added, {{value1}} lines deleted',
      { value0: added, value1: removed }
    )
  }
  if (added > 0) {
    return translate(
      'auto.components.right.sidebar.source.control.branch.line.total.chip.8a9b97b666',
      '{{value0}} lines added',
      { value0: added }
    )
  }
  return translate(
    'auto.components.right.sidebar.source.control.branch.line.total.chip.52c366d88d',
    '{{value0}} lines deleted',
    { value0: removed }
  )
}

// The chip takes no focus; the split still reaches assistive tech through the
// label rather than the hover-only panel.
function appendTestSplitToLabel(label: string, testAdded: number, testRemoved: number): string {
  return translate(
    'auto.components.right.sidebar.source.control.branch.line.total.chip.4c1f70ba92',
    '{{value0}} — test code: {{value1}} lines added, {{value2}} lines deleted',
    { value0: label, value1: testAdded, value2: testRemoved }
  )
}

function appendGeneratedSplitToLabel(label: string, added: number, removed: number): string {
  return translate(
    'auto.components.right.sidebar.source.control.branch.line.total.chip.7f3e1a9c24',
    '{{value0}} — generated: {{value1}} lines added, {{value2}} lines deleted',
    { value0: label, value1: added, value2: removed }
  )
}

type LineTotalSplitRow = { key: string; label: string; added: number; removed: number }

function LineCountPair({
  added,
  removed,
  locale
}: {
  added: number
  removed: number
  locale: string
}): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap tabular-nums">
      <span className="text-[color:var(--git-decoration-added)]">
        +{added.toLocaleString(locale)}
      </span>
      <span className="text-[color:var(--git-decoration-deleted)]">
        -{removed.toLocaleString(locale)}
      </span>
    </span>
  )
}

function CodeBreakdownPanel({
  rows,
  locale
}: {
  rows: LineTotalSplitRow[]
  locale: string
}): React.JSX.Element {
  return (
    <div className="min-w-[14rem]" data-testid="source-control-branch-line-total-breakdown">
      <div className="border-b border-border/60 px-3 py-2.5">
        <div className="text-sm font-semibold text-popover-foreground">
          {translate(
            'auto.components.right.sidebar.source.control.branch.line.total.chip.a1b2c3d4e5',
            'Code breakdown'
          )}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.source.control.branch.line.total.chip.b2c3d4e5f6',
            'Lines of code'
          )}
        </div>
      </div>
      <div className="space-y-1.5 px-3 py-2.5">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-4 text-xs leading-5">
            <span className="text-muted-foreground">{row.label}</span>
            <LineCountPair added={row.added} removed={row.removed} locale={locale} />
          </div>
        ))}
      </div>
    </div>
  )
}

// Genuinely-empty (`+0 -0`), not-yet-published and unknown-after-timeout all
// render as nothing: no reserved width, no placeholder. There is no loading
// state because a null total is indistinguishable from permanent absence (old
// host, failed diff, cooldown), and the store now keeps the last published
// total across a soft miss so the slot rarely empties once filled.
// Not clickable — `openBranchAllDiffs` is narrower.
export const SourceControlBranchLineTotalChip = React.memo(
  function SourceControlBranchLineTotalChip({
    branchLineTotal
  }: {
    branchLineTotal: GitBranchLineTotal | null | undefined
  }): React.JSX.Element | null {
    const added = branchLineTotal?.added ?? 0
    const removed = branchLineTotal?.removed ?? 0
    const hasAdded = added > 0
    const hasRemoved = removed > 0
    // Why: hosts predating either split omit the field; inventing a zero share
    // there would be confidently wrong, so the breakdown is dropped per field.
    const testTotal = branchLineTotal?.test
    const testAdded = testTotal?.added
    const testRemoved = testTotal?.removed
    const generatedTotal = branchLineTotal?.generated
    const generatedAdded = generatedTotal?.added
    const generatedRemoved = generatedTotal?.removed
    // Full precision and app-locale-aware; a status tick that leaves the counts
    // alone must not rebuild these strings.
    const locale = getIntlLocale()
    const addedText = useMemo(() => added.toLocaleString(locale), [added, locale])
    const removedText = useMemo(() => removed.toLocaleString(locale), [removed, locale])
    const accessibleLabel = useMemo(() => {
      let label = buildAccessibleLabel(added, removed)
      // Zero test share still shows in the hover panel; don't announce noise.
      if (testAdded != null && testRemoved != null && (testAdded > 0 || testRemoved > 0)) {
        label = appendTestSplitToLabel(label, testAdded, testRemoved)
      }
      if (
        generatedAdded != null &&
        generatedRemoved != null &&
        (generatedAdded > 0 || generatedRemoved > 0)
      ) {
        label = appendGeneratedSplitToLabel(label, generatedAdded, generatedRemoved)
      }
      return label
    }, [added, removed, testAdded, testRemoved, generatedAdded, generatedRemoved])
    const splitRows = useMemo<LineTotalSplitRow[]>(() => {
      // Why: the fields ship together today but the type is independent so a
      // host can gain one before the other; either alone is enough to render.
      const hasTest = testAdded != null && testRemoved != null
      const hasGenerated = generatedAdded != null && generatedRemoved != null
      if (!hasTest && !hasGenerated) {
        return []
      }

      const rows: LineTotalSplitRow[] = [
        {
          key: 'source',
          // Only "Source" once both splits are known — with one missing the
          // remainder still contains the other bucket, so name what was taken out.
          label:
            hasTest && hasGenerated
              ? translate(
                  'auto.components.right.sidebar.source.control.branch.line.total.chip.c8d5b21e07',
                  'Source'
                )
              : hasTest
                ? translate(
                    'auto.components.right.sidebar.source.control.branch.line.total.chip.9e4a3c5081',
                    'Non-test'
                  )
                : translate(
                    'auto.components.right.sidebar.source.control.branch.line.total.chip.3d7e9b1042',
                    'Non-generated'
                  ),
          added: added - (testAdded ?? 0) - (generatedAdded ?? 0),
          removed: removed - (testRemoved ?? 0) - (generatedRemoved ?? 0)
        }
      ]
      if (hasTest) {
        rows.push({
          key: 'test',
          label: translate(
            'auto.components.right.sidebar.source.control.branch.line.total.chip.6b2d0f14a7',
            'Tests'
          ),
          added: testAdded,
          removed: testRemoved
        })
      }
      // Why: "no tests in this branch" is worth showing as +0 -0; "nothing was
      // generated" is the normal case, so that row is dropped instead.
      if (hasGenerated && (generatedAdded > 0 || generatedRemoved > 0)) {
        rows.push({
          key: 'generated',
          label: translate(
            'auto.components.right.sidebar.source.control.branch.line.total.chip.7a04c6f8b3',
            'Generated'
          ),
          added: generatedAdded,
          removed: generatedRemoved
        })
      }
      return rows
    }, [added, removed, testAdded, testRemoved, generatedAdded, generatedRemoved])

    if (!hasAdded && !hasRemoved) {
      return null
    }

    // Why: no fixed `ch` width — that clips at 5+ digits; `tabular-nums` alone
    // keeps digits from jittering between refreshes.
    // `cursor-help` signals hover detail without implying a click target.
    const hasBreakdown = splitRows.length > 0
    const chip = (
      <span
        role="group"
        aria-label={accessibleLabel}
        data-testid="source-control-branch-line-total"
        className={
          hasBreakdown
            ? 'inline-flex shrink-0 cursor-help items-center gap-1 whitespace-nowrap tabular-nums'
            : 'inline-flex shrink-0 items-center gap-1 whitespace-nowrap tabular-nums'
        }
      >
        {hasAdded ? (
          <span aria-hidden="true" className="text-[color:var(--git-decoration-added)]">
            +{addedText}
          </span>
        ) : null}
        {hasRemoved ? (
          <span aria-hidden="true" className="text-[color:var(--git-decoration-deleted)]">
            -{removedText}
          </span>
        ) : null}
      </span>
    )

    if (!hasBreakdown) {
      return chip
    }

    return (
      <HoverCard openDelay={200} closeDelay={100}>
        <HoverCardTrigger asChild>{chip}</HoverCardTrigger>
        <HoverCardContent align="end" side="bottom" sideOffset={6} className="w-auto p-0">
          <CodeBreakdownPanel rows={splitRows} locale={locale} />
        </HoverCardContent>
      </HoverCard>
    )
  }
)
