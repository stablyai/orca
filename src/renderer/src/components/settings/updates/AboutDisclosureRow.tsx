import type React from 'react'
import { useId } from 'react'
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
  const summaryId = useId()
  return (
    <>
      <div data-settings-row="" className="@container/about-row">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3">
          <button
            ref={toggleRef}
            type="button"
            aria-expanded={open}
            aria-describedby={summary ? summaryId : undefined}
            onClick={() => onOpenChange(!open)}
            className="col-start-1 row-start-1 flex min-w-0 items-center gap-3 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <span aria-hidden className="grid w-7 shrink-0 place-items-center">
              <ChevronRight
                className={cn(
                  'size-3.5 text-muted-foreground transition-transform motion-reduce:transition-none',
                  open && 'rotate-90'
                )}
              />
            </span>
            <span className="min-w-0 truncate text-sm font-medium">{label}</span>
          </button>
          {summary ? (
            <span
              id={summaryId}
              className="col-start-1 row-start-2 ms-10 truncate text-settings-detail text-muted-foreground @max-xs/about-row:col-end-3"
            >
              {summary}
            </span>
          ) : null}
          {control ? (
            <div
              className={cn(
                'col-start-2 row-start-1',
                summary && 'row-end-3 @max-xs/about-row:row-end-2'
              )}
            >
              {control}
            </div>
          ) : null}
        </div>
      </div>
      {open ? <SettingsGroupNestedRows>{children}</SettingsGroupNestedRows> : null}
    </>
  )
}
