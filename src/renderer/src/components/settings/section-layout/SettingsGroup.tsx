import type React from 'react'
import { cn } from '@/lib/class-names'

type SettingsGroupProps = {
  title?: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  children?: React.ReactNode
  className?: string
  bodyClassName?: string
  /** Anchors the card, the same element a search for the group title lands on. */
  id?: string
  onHeaderClick?: (event: React.MouseEvent<HTMLDivElement>) => void
}

// Title sits outside the card so each group's start and end read at a glance.
export function SettingsGroup({
  title,
  description,
  action,
  children,
  className,
  bodyClassName,
  id,
  onHeaderClick
}: SettingsGroupProps): React.JSX.Element {
  return (
    <section data-settings-group="" className={cn('space-y-3', className)}>
      {title ? (
        <SettingsGroupHeader
          title={title}
          description={description}
          action={action}
          onClick={onHeaderClick}
        />
      ) : null}
      <div
        id={id}
        className={cn(
          // Search can filter out every row; hide the empty card but keep the header and its action.
          'overflow-hidden rounded-xl border border-border bg-card/50 px-5 shadow-xs has-[>[data-settings-group-body]:empty]:hidden',
          bodyClassName
        )}
      >
        {/* A row inside another row (a sub-field) draws no rule; each outermost row draws one and the card clips the first. */}
        <div
          data-settings-group-body=""
          className="-mt-px [&_[data-settings-row]:not([data-settings-group-body]_[data-settings-row]_*)]:border-t [&_[data-settings-row]:not([data-settings-group-body]_[data-settings-row]_*)]:border-t-border"
        >
          {children}
        </div>
      </div>
    </section>
  )
}

// Shared so lists that must keep row identity across groups can draw the same header.
export function SettingsGroupHeader({
  title,
  description,
  action,
  className,
  onClick
}: Pick<SettingsGroupProps, 'title' | 'description' | 'action' | 'className'> & {
  onClick?: (event: React.MouseEvent<HTMLDivElement>) => void
}): React.JSX.Element {
  return (
    <div className={cn('flex items-end justify-between gap-3 px-1', className)} onClick={onClick}>
      <div className="min-w-0 space-y-1">
        <h3 data-settings-group-heading="" className="text-base font-semibold leading-tight">
          {title}
        </h3>
        {description ? (
          <p data-settings-group-description="" className="text-xs text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}
