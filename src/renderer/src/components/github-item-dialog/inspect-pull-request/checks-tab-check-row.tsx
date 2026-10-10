import React from 'react'
import { ChevronDown, CircleDashed } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CHECK_COLOR, CHECK_ICON } from '@/components/right-sidebar/checks-panel/check-presentation'
import type { CheckDetailsLoadState } from '@/components/github-checks-tab-state'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import { getCheckConclusion } from '@/components/pr-check-counts'
import { getCheckDetailsKey, getCheckStatusLabel } from '@/components/github/pr-check-presentation'
import { ChecksTabCheckDetails } from './checks-tab-check-details'

export function renderCheckRow({
  check,
  variant,
  expandedCheckKey,
  detailsByCheckKey,
  onToggle,
  requestCheckDetails
}: {
  check: PRCheckDetail
  variant: 'compact' | 'page'
  expandedCheckKey: string | null
  detailsByCheckKey: Record<string, CheckDetailsLoadState | undefined>
  onToggle: (check: PRCheckDetail) => void
  requestCheckDetails: (check: PRCheckDetail, key: string) => void
}): React.JSX.Element {
  const key = getCheckDetailsKey(check)
  return (
    <ChecksTabCheckRow
      key={key}
      check={check}
      variant={variant}
      expanded={expandedCheckKey === key}
      detailsState={detailsByCheckKey[key]}
      onToggle={onToggle}
      onRetry={requestCheckDetails}
    />
  )
}

export function ChecksTabCheckRow({
  check,
  variant,
  expanded,
  detailsState,
  onToggle,
  onRetry
}: {
  check: PRCheckDetail
  variant: 'compact' | 'page'
  expanded: boolean
  detailsState: CheckDetailsLoadState | undefined
  onToggle: (check: PRCheckDetail) => void
  onRetry: (check: PRCheckDetail, key: string) => void
}): React.JSX.Element {
  const conclusion = getCheckConclusion(check)
  const Icon = CHECK_ICON[conclusion] ?? CircleDashed
  const color = CHECK_COLOR[conclusion] ?? 'text-muted-foreground'
  const statusLabel = getCheckStatusLabel(check)
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => onToggle(check)}
        aria-expanded={expanded}
        className={cn(
          'flex w-full min-w-0 items-center gap-2 rounded-md text-left transition',
          variant === 'page' ? 'px-3 py-2.5 hover:bg-accent/60' : 'px-2 py-1.5 hover:bg-muted/40'
        )}
      >
        <ChevronDown
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform',
            !expanded && '-rotate-90'
          )}
        />
        <Icon
          className={cn('size-3.5 shrink-0', color, conclusion === 'pending' && 'animate-spin')}
        />
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">{check.name}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{statusLabel}</span>
      </button>
      {expanded ? (
        <ChecksTabCheckDetails check={check} state={detailsState} onRetry={onRetry} />
      ) : null}
    </div>
  )
}
