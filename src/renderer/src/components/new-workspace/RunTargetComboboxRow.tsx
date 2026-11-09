import React from 'react'
import { Check, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ProjectOptionDetail } from './ProjectComboboxRow'
import { HostRowIcon } from '../host-row-icon'

export { HostRowIcon }

/** Match the project picker with details below each target name. */
export function RunTargetRow({
  icon,
  label,
  detail,
  armed,
  current,
  optionId,
  dimmed = false,
  submenu = false,
  stacked = true,
  labelBadge,
  wrapDetail = false,
  onArm,
  onCommit,
  trailing
}: {
  icon: React.ReactNode
  label: string
  detail: string
  armed: boolean
  current: boolean
  optionId: string | undefined
  /** Not-ready hosts are dormant, not errors — quiet them without disabling. */
  dimmed?: boolean
  /** Opens a nested list, so it gets a trailing chevron. */
  submenu?: boolean
  /** Two-line card: label over description, for rows that need explaining. */
  stacked?: boolean
  onArm: () => void
  onCommit: () => void
  trailing?: React.ReactNode
  /** Stacked rows only: a small badge beside the label, keeping the detail line full width. */
  labelBadge?: React.ReactNode
  /** Stacked rows only: plain copy that may wrap to two lines instead of path-eliding. */
  wrapDetail?: boolean
}): React.JSX.Element {
  return (
    <div
      role="option"
      id={optionId}
      aria-selected={armed}
      // option supports aria-haspopup but not aria-expanded; submenus are listboxes.
      aria-haspopup={submenu ? 'listbox' : undefined}
      data-armed={armed || undefined}
      data-current={current ? 'true' : undefined}
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={onArm}
      onClick={onCommit}
      className={cn(
        'flex cursor-default gap-2 rounded-sm px-2 text-sm',
        stacked ? 'items-center py-1.5' : 'h-8 items-baseline',
        armed && 'bg-accent text-accent-foreground'
      )}
    >
      <span
        className={cn(
          'flex w-4 shrink-0 items-center justify-center',
          stacked ? 'h-5' : 'h-8',
          stacked && detail && 'self-start',
          dimmed && 'opacity-60'
        )}
      >
        {icon}
      </span>
      {stacked ? (
        <span className={cn('flex min-w-0 flex-1 flex-col', dimmed && 'opacity-60')}>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={cn('truncate', current && 'font-medium')}>{label}</span>
            {labelBadge}
          </span>
          {detail && wrapDetail ? (
            <span className="line-clamp-2 text-xs text-muted-foreground">{detail}</span>
          ) : detail ? (
            <ProjectOptionDetail detail={detail} className="text-xs text-muted-foreground" />
          ) : null}
        </span>
      ) : (
        <>
          <span
            className={cn(
              'max-w-[50%] shrink truncate',
              current && 'font-medium',
              dimmed && 'opacity-60'
            )}
          >
            {label}
          </span>
          <ProjectOptionDetail
            detail={detail}
            className={cn(
              'ml-auto min-w-0 flex-1 shrink-[999] justify-end pl-2 text-right text-xs text-muted-foreground',
              dimmed && 'opacity-60'
            )}
          />
        </>
      )}
      {trailing}
      {/* The committed row gets a check, not a second fill, so only the armed row is shaded. */}
      {current ? (
        <span className={cn('flex shrink-0 items-center pl-1.5', stacked ? 'self-center' : 'h-8')}>
          <Check className="size-3.5 text-muted-foreground" />
        </span>
      ) : null}
      {submenu ? (
        <span className={cn('flex shrink-0 items-center pl-1.5', stacked ? 'self-center' : 'h-8')}>
          <ChevronRight className="size-3.5 text-muted-foreground" />
        </span>
      ) : null}
    </div>
  )
}
