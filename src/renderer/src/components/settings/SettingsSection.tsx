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
}

export function SettingsSection({
  id,
  title,
  description,
  searchEntries,
  children,
  className
}: SettingsSectionProps): React.JSX.Element | null {
  const query = useAppStore((state) => state.settingsSearchQuery)
  if (!matchesSettingsSearch(query, searchEntries)) {
    return null
  }

  return (
    <section id={id} data-settings-section={id} className={className ?? 'space-y-6 scroll-mt-6'}>
      <div className="space-y-1">
        <h2 className="text-xl font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  )
}
