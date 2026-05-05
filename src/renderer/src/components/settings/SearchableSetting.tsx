import type React from 'react'
import { useAppStore } from '../../store'
import { matchesSettingsSearch, type SettingsSearchEntry } from './settings-search'

type SearchableSettingProps = SettingsSearchEntry & {
  children: React.ReactNode
  className?: string
  id?: string
}

export function SearchableSetting({
  title,
  description,
  keywords,
  children,
  className,
  id
}: SearchableSettingProps): React.JSX.Element | null {
  const query = useAppStore((state) => state.settingsSearchQuery)
  if (!matchesSettingsSearch(query, { title, description, keywords })) {
    return null
  }

  return (
    <div className={className} id={id}>
      {children}
    </div>
  )
}
