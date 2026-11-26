import type React from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { SettingsGroupNestedRows } from '../section-layout/SettingsGroup'

type AboutDisclosureRowProps = {
  label: React.ReactNode
  /** One muted status line under the label; `@max-xs/about-row:` variants can shorten it when narrow. */
  summary?: React.ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  toggleRef?: React.Ref<HTMLButtonElement>
  /** The row's one trailing control; it stays outside the toggle so it never folds the row. */
  control?: React.ReactNode
  children: React.ReactNode
}

/** A card row whose label folds sub-rows open in place, with its own control on the right. */
export function AboutDisclosureRow({
  label,
  summary,
  open,
  onOpenChange,
  toggleRef,
  control,
  children
}: AboutDisclosureRowProps): React.JSX.Element {
  return (
    <>
      <div data-settings-row="" className="@container/about-row flex items-center gap-3">
        <button
          ref={toggleRef}
          type="button"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
              open && 'rotate-90'
            )}
          />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{label}</span>
            {summary ? (
              <span className="block truncate text-settings-detail text-muted-foreground">
                {summary}
              </span>
            ) : null}
          </span>
        </button>
        {control ? <div className="shrink-0">{control}</div> : null}
      </div>
      {open ? <SettingsGroupNestedRows>{children}</SettingsGroupNestedRows> : null}
    </>
  )
}
