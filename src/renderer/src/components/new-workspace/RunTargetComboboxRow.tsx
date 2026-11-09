import React from 'react'
import { Check, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'
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
  detailNode,
  armedInSubmenu = false,
  disabled = false,
  busy = false,
  onArm,
  onCommit,
  trailing
}: {
  icon: React.ReactNode
  label: string
  detail: string
  armed: boolean
  current: boolean
  /** Stable per row, so `aria-activedescendant` changes as the arm moves. */
  optionId: string
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
  /** Stacked rows only: rich detail (e.g. specs that hide at narrow widths) instead of `detail`. */
  detailNode?: React.ReactNode
  /** Can't be picked (e.g. a member blocked by billing); announced and quieted, still arm-able. */
  disabled?: boolean
  /** A pick on this row is waiting (e.g. on billing). */
  busy?: boolean
  /** Keyboard focus moved into this row's submenu: keep a lighter fill so the path stays visible. */
  armedInSubmenu?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const hasDetail = Boolean(detailNode ?? detail)
  return (
    <div
      role="option"
      id={optionId}
      aria-selected={armed}
      aria-disabled={disabled || undefined}
      aria-busy={busy || undefined}
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
        armed &&
          (armedInSubmenu
            ? // A faint fill plus an inset ring keeps the path distinct from the armed child (dark mode too).
              'bg-accent/30 ring-1 ring-inset ring-border'
            : 'bg-accent text-accent-foreground')
      )}
    >
      <span
        className={cn(
          'flex w-4 shrink-0 items-center justify-center',
          stacked ? 'h-5' : 'h-8',
          stacked && hasDetail && 'self-start',
          (dimmed || disabled) && 'opacity-60'
        )}
      >
        {icon}
      </span>
      {stacked ? (
        <span className={cn('flex min-w-0 flex-1 flex-col', (dimmed || disabled) && 'opacity-60')}>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={cn('truncate', current && 'font-medium')}>{label}</span>
            {labelBadge}
          </span>
          {detailNode ? (
            <span className="truncate text-xs text-muted-foreground">{detailNode}</span>
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
          <Check aria-hidden className="size-3.5 text-muted-foreground" />
          {/* aria-selected follows the arm, so the committed choice is announced in its name. */}
          <span className="sr-only">
            {t('auto.components.new.workspace.RunTargetCombobox.currentSuffix', '(current)')}
          </span>
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
