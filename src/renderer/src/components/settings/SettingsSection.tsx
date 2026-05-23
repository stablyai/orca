import type React from 'react'
import { createContext, useContext } from 'react'
import { useAppStore } from '../../store'
import type { SettingsSearchEntry } from './settings-search'
import { matchesSettingsSearch } from './settings-search'

// Why: avoids threading `activeSectionId` through every <SettingsSection /> call
// site in Settings.tsx — the page wraps its content tree in this provider.
const ActiveSettingsSectionContext = createContext<string | null>(null)

export const ActiveSettingsSectionProvider = ActiveSettingsSectionContext.Provider

type SettingsSectionProps = {
  id: string
  title: string
  description: string
  searchEntries?: SettingsSearchEntry[]
  children?: React.ReactNode
  className?: string
  badge?: string
  badgeAccessory?: React.ReactNode
  forceVisible?: boolean
  /** When true, this section is the one currently selected in the sidebar.
   *  Sections render only when active or when a non-empty search matches them
   *  — that way the Settings page shows one focused pane at a time instead of
   *  one giant scrolling document. */
  isActive?: boolean
  /** Rendered in the section header's upper-right corner — intended for
   *  section-scoped actions (e.g. "Import from Ghostty") that would otherwise
   *  crowd the settings list as their own row. */
  headerAction?: React.ReactNode
}

export function SettingsSection({
  id,
  title,
  description,
  searchEntries,
  children,
  className,
  badge,
  badgeAccessory,
  forceVisible = false,
  isActive,
  headerAction
}: SettingsSectionProps): React.JSX.Element | null {
  const query = useAppStore((state) => state.settingsSearchQuery)
  const activeFromContext = useContext(ActiveSettingsSectionContext)
  const sectionIsActive = isActive ?? activeFromContext === id
  const hasQuery = query.trim() !== ''
  const matchesQuery = !searchEntries || matchesSettingsSearch(query, searchEntries)
  if (!forceVisible) {
    if (hasQuery) {
      if (!matchesQuery) {
        return null
      }
    } else if (!sectionIsActive) {
      return null
    }
  }

  return (
    <section id={id} data-settings-section={id} className={className ?? 'scroll-mt-6 space-y-6'}>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            {title}
            {badge ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {badge}
              </span>
            ) : null}
            {badgeAccessory}
          </h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
      </div>
      {children}
    </section>
  )
}
