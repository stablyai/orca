import type React from 'react'
import { useId } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { SettingsSubsectionHeader } from '../form-controls/SettingsFormControls'

// The card's side inset. Content that must span to the card edges cancels it with the bleed
// class; a bleeding row restores the inset on its own content with the row bleed class.
const SETTINGS_GROUP_INSET_CLASS = 'px-5'
export const SETTINGS_GROUP_BLEED_CLASS = '-mx-5'
export const SETTINGS_GROUP_ROW_BLEED_CLASS = '-mx-5 px-5'
// The one indent step for rows that sit under another row or an Advanced disclosure.
export const SETTINGS_GROUP_NESTED_INSET_CLASS = 'pl-5'

type SettingsGroupCollapse = {
  open: boolean
  onToggle: () => void
  /** Search forces groups open; collapsing would hide matches. */
  disabled?: boolean
  /** Shown in place of the description while closed. */
  summary?: React.ReactNode
}

type SettingsGroupProps = {
  id?: string
  title?: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  children?: React.ReactNode
  className?: string
  bodyClassName?: string
  onHeaderClick?: (event: React.MouseEvent<HTMLDivElement>) => void
  /** The header toggles the card; children stay mounted while closed so drafts survive. */
  collapse?: SettingsGroupCollapse
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
  onHeaderClick,
  collapse
}: SettingsGroupProps): React.JSX.Element {
  const bodyId = useId()
  const buttonId = useId()
  const card = (
    <div
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
    <section id={id} className={cn('space-y-3', className)}>
      {title ? (
        <SettingsGroupHeader
          title={title}
          description={collapse && !collapse.open ? collapse.summary : description}
          action={action}
          onClick={onHeaderClick}
          collapse={collapse ? { ...collapse, controls: bodyId, buttonId } : undefined}
        />
      ) : null}
      {collapse ? (
        <div
          id={bodyId}
          role="region"
          aria-labelledby={title ? buttonId : undefined}
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
            collapse.open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          )}
          aria-hidden={!collapse.open}
          inert={!collapse.open}
        >
          <div className="min-h-0 overflow-hidden">{card}</div>
        </div>
      ) : (
        card
      )}
    </section>
  )
}

// Shared so lists that must keep row identity across groups can draw the same header.
export function SettingsGroupHeader({
  title,
  description,
  action,
  className,
  onClick,
  collapse
}: Pick<SettingsGroupProps, 'title' | 'description' | 'action' | 'className'> & {
  onClick?: (event: React.MouseEvent<HTMLDivElement>) => void
  collapse?: SettingsGroupCollapse & { controls: string; buttonId: string }
}): React.JSX.Element {
  const descriptionNode = description ? (
    <p
      data-settings-group-description=""
      className={cn(
        'text-xs text-muted-foreground',
        // Aligns with the title past the chevron (size-4 + gap-2).
        collapse && 'pl-6',
        collapse && !collapse.open && 'truncate'
      )}
    >
      {description}
    </p>
  ) : null
  const toggleFromHeader = collapse && !collapse.disabled ? collapse.onToggle : undefined
  const handleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    onClick?.(event)
    // The whole header toggles, as the old accordion did; buttons (the toggle itself, actions) handle their own clicks.
    if (toggleFromHeader && !(event.target as Element).closest('button, a, input')) {
      toggleFromHeader()
    }
  }
  return (
    <div
      className={cn(
        'flex items-end justify-between gap-3 px-1',
        // Same box whether or not search disables the toggle, so forcing it open shifts nothing.
        collapse && '-mx-1 rounded-md px-2 py-1.5 transition-colors',
        toggleFromHeader && 'cursor-pointer hover:bg-accent/15',
        className
      )}
      onClick={handleClick}
    >
      <div className={cn('min-w-0 space-y-1', collapse && 'flex-1')}>
        <h3 data-settings-group-heading="" className="text-base font-semibold leading-tight">
          {collapse ? (
            // Accordion header pattern: the button lives inside the heading so it stays in heading navigation.
            <button
              type="button"
              id={collapse.buttonId}
              aria-expanded={collapse.open}
              aria-controls={collapse.controls}
              onClick={collapse.onToggle}
              disabled={collapse.disabled}
              className="flex w-full min-w-0 items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default"
            >
              <ChevronRight
                className={cn(
                  'size-4 shrink-0 text-muted-foreground transition-transform',
                  collapse.open && 'rotate-90 text-foreground'
                )}
              />
              <span className="min-w-0">{title}</span>
            </button>
          ) : (
            title
          )}
        </h3>
        {descriptionNode}
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
