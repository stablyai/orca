import React, { useMemo } from 'react'
import type { GitBranchLineTotal } from '../../../../../../shared/git-status-types'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'

// Use raw digits for accessibility; some screen-reader locales split grouped numbers into separate values.
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

// Expose the split in the label because the unfocusable chip's hover panel is inaccessible to keyboard users.
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

// Hide empty/absent totals: older hosts and failures may never send one. No click action because openBranchAllDiffs has narrower scope.
export const SourceControlBranchLineTotalChip = React.memo(
  function SourceControlBranchLineTotalChip({
    branchLineTotal
  }: {
    branchLineTotal: GitBranchLineTotal | null | undefined
  }): React.JSX.Element | null {
    const languageRevision = useUiLanguageRevision()
    const added = branchLineTotal?.added ?? 0
    const removed = branchLineTotal?.removed ?? 0
    const hasAdded = added > 0
    const hasRemoved = removed > 0
    // Older hosts omit splits; absent fields cannot claim measured zero shares.
    const testTotal = branchLineTotal?.test
    const testAdded = testTotal?.added
    const testRemoved = testTotal?.removed
    const generatedTotal = branchLineTotal?.generated
    const generatedAdded = generatedTotal?.added
    const generatedRemoved = generatedTotal?.removed
    // Memoize locale-formatted counts so unchanged status polls do not rebuild strings.
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
      // Splits can arrive independently across host versions; render either one alone.
      const hasTest = testAdded != null && testRemoved != null
      const hasGenerated = generatedAdded != null && generatedRemoved != null
      if (!hasTest && !hasGenerated) {
        return []
      }

      const rows: LineTotalSplitRow[] = [
        {
          key: 'source',
          // Call the remainder Source only with both splits; an omitted bucket may still be included.
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
      // Show measured zero tests, but omit zero generated lines because that is the normal case.
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
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- translate() reads the UI language implicitly.
    }, [added, removed, testAdded, testRemoved, generatedAdded, generatedRemoved, languageRevision])

    if (!hasAdded && !hasRemoved) {
      return null
    }

    // Use tabular digits without fixed width so large totals fit; cursor-help promises hover detail rather than clicking.
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
