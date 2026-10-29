import React from 'react'
import {
  AlertTriangle,
  CircleCheck,
  CircleDashed,
  CircleX,
  LoaderCircle,
  RefreshCw,
  Sparkles
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import type { ConflictReview } from './conflict-summary'
import { summarizeProviderChecks } from '../../../../../shared/provider-check-summary'
import { translate } from '@/i18n/i18n'

export function PRTriageStrip({
  review,
  pr,
  reviewKind = 'PR',
  checks,
  isResolvingConflictsWithAI,
  onResolveConflictsWithAI,
  resolveConflictsDisabled,
  resolveConflictsDisabledReason,
  isFixingChecksWithAI,
  onFixChecksWithAI,
  fixChecksDisabled,
  fixChecksDisabledReason
}: {
  review?: ConflictReview
  pr?: ConflictReview
  reviewKind?: 'PR' | 'MR'
  checks: PRCheckDetail[]
  isResolvingConflictsWithAI: boolean
  onResolveConflictsWithAI: () => void
  resolveConflictsDisabled?: boolean
  resolveConflictsDisabledReason?: string
  isFixingChecksWithAI: boolean
  onFixChecksWithAI: () => void
  fixChecksDisabled?: boolean
  fixChecksDisabledReason?: string
}): React.JSX.Element {
  const resolvedReview = review ?? pr
  // Share the pill's classifier so completed checks without conclusions remain unresolved rather than spinning.
  const summary = summarizeProviderChecks(checks)
  const failingCount = summary.failed
  const pendingCount = summary.pending

  if (resolvedReview?.mergeable === 'CONFLICTING') {
    return (
      <ConflictTriageStrip
        reviewKind={reviewKind}
        isResolvingConflictsWithAI={isResolvingConflictsWithAI}
        onResolveConflictsWithAI={onResolveConflictsWithAI}
        resolveConflictsDisabled={resolveConflictsDisabled}
        resolveConflictsDisabledReason={resolveConflictsDisabledReason}
      />
    )
  }

  if (failingCount > 0) {
    return (
      <div className="border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <CircleX className="size-3.5 shrink-0 text-rose-500" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] font-medium text-foreground">
              {translate(
                'auto.components.right.sidebar.checks.panel.content.failingChecks',
                '{{count}} failing checks',
                { count: failingCount, defaultValue_one: '{{count}} failing check' }
              )}
            </div>
            <div className="truncate text-[10px] text-muted-foreground">
              {translate(
                'auto.components.right.sidebar.checks.panel.content.5d4ebf9391',
                'Inspect details or start an AI fix pass.'
              )}
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={isFixingChecksWithAI || fixChecksDisabled}
            title={fixChecksDisabled ? fixChecksDisabledReason : undefined}
            onClick={onFixChecksWithAI}
          >
            {isFixingChecksWithAI ? (
              <RefreshCw className="size-3 animate-spin" />
            ) : (
              <Sparkles className="size-3" />
            )}
            {translate('auto.components.right.sidebar.checks.panel.content.b45db92d0e', 'Fix')}
          </Button>
        </div>
      </div>
    )
  }

  if (pendingCount > 0) {
    return (
      <div className="border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-amber-500" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] font-medium text-foreground">
              {translate(
                'auto.components.right.sidebar.checks.panel.content.pendingChecks',
                '{{count}} checks pending',
                { count: pendingCount, defaultValue_one: '{{count}} check pending' }
              )}
            </div>
            <div className="truncate text-[10px] text-muted-foreground">
              {translate(
                'auto.components.right.sidebar.checks.panel.content.5856874b59',
                'Orca will refresh checks while this panel stays open.'
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // An all-unresolved list must match the grey pill, not show a green tick.
  if (summary.state === 'neutral') {
    return (
      <div className="border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <CircleDashed className="size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] font-medium text-foreground">
              {translate(
                'auto.components.right.sidebar.checks.panel.content.unresolvedChecks',
                '{{count}} checks unresolved',
                { count: summary.neutral, defaultValue_one: '{{count}} check unresolved' }
              )}
            </div>
            <div className="truncate text-[10px] text-muted-foreground">
              {translate(
                'auto.components.right.sidebar.checks.panel.content.checksUnresolvedStripHint',
                'These checks finished without a pass or fail verdict.'
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="border-b border-border px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <CircleCheck className="size-3.5 shrink-0 text-emerald-500" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-medium text-foreground">
            {translate(
              'auto.components.right.sidebar.checks.panel.content.9d0e7bcefc',
              'No blocking PR action'
            )}
          </div>
          <div className="truncate text-[10px] text-muted-foreground">
            {translate(
              'auto.components.right.sidebar.checks.panel.content.c16762ac8c',
              'Checks and comments below show the current fetched context.'
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export function ConflictTriageStrip({
  reviewKind,
  isResolvingConflictsWithAI,
  onResolveConflictsWithAI,
  resolveConflictsDisabled,
  resolveConflictsDisabledReason
}: {
  reviewKind: 'PR' | 'MR'
  isResolvingConflictsWithAI: boolean
  onResolveConflictsWithAI: () => void
  resolveConflictsDisabled?: boolean
  resolveConflictsDisabledReason?: string
}): React.JSX.Element {
  return (
    <div className="border-b border-border px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-medium text-foreground">
            {reviewKind === 'MR'
              ? translate(
                  'auto.components.right.sidebar.checks.panel.content.conflictsBlockThisMr',
                  'Conflicts block this MR'
                )
              : translate(
                  'auto.components.right.sidebar.checks.panel.content.conflictsBlockThisPr',
                  'Conflicts block this PR'
                )}
          </div>
          <div className="truncate text-[10px] text-muted-foreground">
            {translate(
              'auto.components.right.sidebar.checks.panel.content.3a71a6ed0b',
              'Resolve conflicts before checks and merge can complete.'
            )}
          </div>
        </div>
        <Button
          type="button"
          variant="default"
          size="xs"
          disabled={isResolvingConflictsWithAI || resolveConflictsDisabled}
          title={resolveConflictsDisabled ? resolveConflictsDisabledReason : undefined}
          onClick={onResolveConflictsWithAI}
        >
          {isResolvingConflictsWithAI ? (
            <RefreshCw className="size-3 animate-spin" />
          ) : (
            <Sparkles className="size-3" />
          )}
          {translate('auto.components.right.sidebar.checks.panel.content.0c96cd25e5', 'Resolve')}
        </Button>
      </div>
    </div>
  )
}
