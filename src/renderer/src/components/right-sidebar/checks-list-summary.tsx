import React from 'react'
import { ChevronDown, CircleCheck, CircleX, LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

export function ChecksListSummary({
  checksExpanded,
  passingCount,
  failingCount,
  pendingCount,
  checksLoading,
  onToggle
}: {
  checksExpanded: boolean
  passingCount: number
  failingCount: number
  pendingCount: number
  checksLoading: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 border-b border-border px-3 py-2 text-left text-[10px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
      onClick={onToggle}
      aria-expanded={checksExpanded}
    >
      <ChevronDown
        className={cn('size-3 shrink-0 transition-transform', !checksExpanded && '-rotate-90')}
      />
      {passingCount > 0 && (
        <span className="flex items-center gap-1">
          <CircleCheck className="size-3 text-emerald-500" />
          {passingCount}{' '}
          {translate('auto.components.right.sidebar.checks.panel.content.02ca4f9074', 'passing')}
        </span>
      )}
      {failingCount > 0 && (
        <span className="flex items-center gap-1">
          <CircleX className="size-3 text-rose-500" />
          {failingCount}{' '}
          {translate('auto.components.right.sidebar.checks.panel.content.5e52f4ef7f', 'failing')}
        </span>
      )}
      {pendingCount > 0 && (
        <span className="flex items-center gap-1">
          <LoaderCircle className="size-3 text-amber-500" />
          {pendingCount}{' '}
          {translate('auto.components.right.sidebar.checks.panel.content.9ad98f2a17', 'pending')}
        </span>
      )}
      <span className="flex-1" />
      {checksLoading && <LoaderCircle className="size-3 animate-spin text-muted-foreground" />}
    </button>
  )
}
