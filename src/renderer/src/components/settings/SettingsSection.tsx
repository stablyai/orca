import type React from 'react'
import { useAppStore } from '../../store'
import { matchesSettingsSearch, type SettingsSearchEntry } from './settings-search'

type SettingsSectionProps = {
  id: string
  title: string
  description: string
  searchEntries: SettingsSearchEntry[]
  children: React.ReactNode
  className?: string
  badge?: string
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
  headerAction
}: SettingsSectionProps): React.JSX.Element | null {
  const query = useAppStore((state) => state.settingsSearchQuery)
  if (!matchesSettingsSearch(query, searchEntries)) {
    return null
  }

  return (
    <section
      id={id}
      data-settings-section={id}
      className={
        // Why: these sections already contain many internal borders and cards, so a lone divider
        // line gets lost in the visual noise. Giving each section its own padded surface creates a
        // clear outer silhouette that still works when the inner content changes.
        className ??
        'scroll-mt-6 space-y-8 rounded-2xl border border-border/60 bg-card/35 px-6 py-6 shadow-sm'
      }
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 text-xl font-semibold">
            {title}
            {badge ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {badge}
              </span>
            ) : null}
          </h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
      </div>
      {children}
    </section>
  )
}
