import type React from 'react'
import { cn } from '@/lib/utils'

type SettingsGroupProps = {
  title?: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  children?: React.ReactNode
  className?: string
  bodyClassName?: string
}

// Title sits outside the card so each group's start and end read at a glance.
export function SettingsGroup({
  title,
  description,
  action,
  children,
  className,
  bodyClassName
}: SettingsGroupProps): React.JSX.Element {
  return (
    <section data-settings-group="" className={cn('space-y-3', className)}>
      {title ? (
        <div className="flex items-end justify-between gap-3 px-1">
          <div className="min-w-0 space-y-1">
            <h3 className="text-base font-semibold leading-tight">{title}</h3>
            {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      <div
        className={cn(
          'overflow-hidden rounded-xl border border-border bg-card/50 px-5 shadow-xs',
          bodyClassName
        )}
      >
        {/* Rows nest at varying depths, so each outermost row draws its own top rule and the card clips the first. */}
        <div
          data-settings-group-body=""
          className="-mt-px [&_[data-settings-row]:not([data-settings-group-body]_[data-settings-row]_*)]:border-t [&_[data-settings-row]:not([data-settings-group-body]_[data-settings-row]_*)]:border-border"
        >
          {children}
        </div>
      </div>
    </section>
  )
}
