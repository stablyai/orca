import type React from 'react'
import { cn } from '@/lib/class-names'
import { SettingsSubsectionHeader } from '../form-controls/SettingsFormControls'

// The card's side inset. Content that must span to the card edges cancels it with the bleed
// class; a bleeding row restores the inset on its own content with the row bleed class.
const SETTINGS_GROUP_INSET_CLASS = 'px-5'
export const SETTINGS_GROUP_BLEED_CLASS = '-mx-5'
export const SETTINGS_GROUP_ROW_BLEED_CLASS = '-mx-5 px-5'
// The one indent step for rows that sit under another row or an Advanced disclosure.
export const SETTINGS_GROUP_NESTED_INSET_CLASS = 'pl-5'

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
  id,
  title,
  description,
  action,
  children,
  className,
  bodyClassName,
  onHeaderClick
}: SettingsGroupProps): React.JSX.Element {
  const card = (
    <div
      id={id}
      data-settings-group-card=""
      className={cn(
        // Search can filter out every row; hide the empty card but keep the header and its action.
        'overflow-hidden rounded-xl border border-border bg-card/50 shadow-xs has-[>[data-settings-group-body]:empty]:hidden',
        SETTINGS_GROUP_INSET_CLASS,
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
  )
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
      {card}
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

/** Sub-rows under a parent row, one fixed step in; they draw their own rules since rows nested in a row draw none. */
export function SettingsGroupNestedRows({
  children
}: {
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        SETTINGS_GROUP_NESTED_INSET_CLASS,
        'divide-y divide-border border-t border-border'
      )}
    >
      {children}
    </div>
  )
}

/** A titled block inside a group's card; its rows keep the card's inset and rules. */
export function SettingsGroupSubsection({
  id,
  title,
  description,
  action,
  children
}: {
  id?: string
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div id={id} className="border-t border-border pt-4">
      <SettingsSubsectionHeader
        className="items-center pb-3"
        title={title}
        description={description}
        action={action}
      />
      {children}
    </div>
  )
}
