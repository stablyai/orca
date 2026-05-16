import type React from 'react'
import { useAppStore } from '../../store'
import { matchesSettingsSearch, type SettingsSearchEntry } from './settings-search'

type SearchableSettingProps = SettingsSearchEntry & {
  children: React.ReactNode
  className?: string
  forceVisible?: boolean
  id?: string
}

export function SearchableSetting({
  title,
  description,
  forceVisible = false,
  keywords,
  children,
  className,
  id
}: SearchableSettingProps): React.JSX.Element | null {
  const query = useAppStore((state) => state.settingsSearchQuery)
  if (!forceVisible && !matchesSettingsSearch(query, { title, description, keywords })) {
    return null
  }

  return (
    <div className={className} id={id}>
      {children}
    </div>
  )
}
