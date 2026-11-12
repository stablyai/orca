import type React from 'react'
import { createContext, useContext } from 'react'
import { cn } from '@/lib/class-names'
import { useAppStore } from '../../../store/index'
import type { SettingsSearchEntry } from '../search/settings-search'
import { matchesSettingsSearch } from '../search/settings-search'

// Share active section through context to avoid threading it through every section call.
const ActiveSettingsSectionContext = createContext<string | null>(null)

export const ActiveSettingsSectionProvider = ActiveSettingsSectionContext.Provider

type SettingsSectionProps = {
  id: string
  title: string
  description: React.ReactNode
  searchEntries?: SettingsSearchEntry[]
  children?: React.ReactNode
  className?: string
  bodyClassName?: string
  /** Pane is built from SettingsGroup cards, so the body drops its own card. Fixed per pane, never query-dependent. */
  grouped?: boolean
  badge?: string
  badgeAccessory?: React.ReactNode
  forceVisible?: boolean
  /** Mount only the selected section, even when search lists several matches. */
  isActive?: boolean
  /** Header-scoped actions, such as Import from Ghostty. */
  headerAction?: React.ReactNode
  /** Drops the title block while the body shows its own page header (a plugin's page). */
  hideHeader?: boolean
  /** Click handler on the section title — the hook for hidden staff
   *  affordances (Option-click reveals), mirroring the Updates header. */
  onTitleClick?: (event: React.MouseEvent<HTMLHeadingElement>) => void
}

export function SettingsSection({
  id,
  title,
  description,
  searchEntries,
  children,
  className,
  bodyClassName,
  grouped = false,
  badge,
  badgeAccessory,
  forceVisible = false,
  isActive,
  headerAction,
  hideHeader = false,
  onTitleClick
}: SettingsSectionProps): React.JSX.Element | null {
  const query = useAppStore((state) => state.settingsSearchQuery)
  const activeFromContext = useContext(ActiveSettingsSectionContext)
  const sectionIsActive = isActive ?? activeFromContext === id
  const hasQuery = query.trim() !== ''
  const matchesQuery = !searchEntries || matchesSettingsSearch(query, searchEntries)
  if (!forceVisible) {
    if (hasQuery) {
      if (!sectionIsActive || !matchesQuery) {
        return null
      }
    } else if (!sectionIsActive) {
      return null
    }
  }

  return (
    <section id={id} data-settings-section={id} className={cn('scroll-mt-8 space-y-6', className)}>
      <div
        hidden={hideHeader}
        className="flex items-start justify-between gap-4 border-b border-border/60 pb-5"
      >
        <div className="min-w-0 flex-1 space-y-2">
          <h2
            className="flex flex-wrap items-center gap-2 text-2xl font-semibold leading-tight text-foreground"
            onClick={onTitleClick}
          >
            {title}
            {badge ? (
              <span className="text-2xs font-normal text-muted-foreground">{badge}</span>
            ) : null}
            {badgeAccessory}
          </h2>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
        {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
      </div>
      <div
        className={cn(
          grouped
            ? 'flex flex-col gap-8'
            : 'rounded-xl border border-border/50 bg-card/50 px-7 py-6 shadow-xs',
          bodyClassName
        )}
      >
        {children}
      </div>
    </section>
  )
}
