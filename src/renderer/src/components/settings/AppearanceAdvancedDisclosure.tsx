import type React from 'react'
import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../store'
import { normalizeSettingsSearchQuery } from './settings-search'
import { translate } from '@/i18n/i18n'

type AppearanceAdvancedDisclosureProps = {
  /** Optional override label; defaults to "Advanced". */
  label?: string
  /** One-line supporting copy shown under the trigger label. */
  description?: React.ReactNode
  /** Collapsed-only summary (e.g. override count). Hidden while expanded. */
  summary?: React.ReactNode
  showTopBorder?: boolean
  className?: string
  contentClassName?: string
  /** Override search force-open. When omitted, any non-empty settings search expands. */
  forceOpen?: boolean
  children: React.ReactNode
}

/** Inline disclosure for low-frequency controls. An active settings search
 *  force-opens it so matching controls stay reachable instead of being hidden
 *  behind a collapsed trigger. */
export function AppearanceAdvancedDisclosure({
  label,
  description,
  summary,
  showTopBorder = true,
  className,
  contentClassName,
  forceOpen,
  children
}: AppearanceAdvancedDisclosureProps): React.JSX.Element {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const isSearching = normalizeSettingsSearchQuery(searchQuery).length > 0
  const [open, setOpen] = useState(false)
  const searchForced = forceOpen ?? isSearching
  const expanded = open || searchForced

  return (
    <div className={cn('mt-3 pt-2', showTopBorder && 'border-t border-border/50', className)}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOpen((prev) => !prev)}
        // Why: while searching the disclosure is forced open, so disable the
        // toggle's collapse affordance rather than letting it fight the search.
        disabled={searchForced}
        className="flex w-full items-center gap-2 py-1 text-left text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-90'
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="block">
            {label ??
              translate(
                'auto.components.settings.AppearanceAdvancedDisclosure.advanced',
                'Advanced'
              )}
          </span>
          {description ? (
            <span className="block truncate text-xs font-normal text-muted-foreground">
              {description}
            </span>
          ) : null}
          {!expanded && summary ? (
            <span className="block truncate text-xs font-normal text-muted-foreground">
              {summary}
            </span>
          ) : null}
        </span>
      </button>
      {expanded ? <div className={cn('pt-1', contentClassName)}>{children}</div> : null}
    </div>
  )
}
