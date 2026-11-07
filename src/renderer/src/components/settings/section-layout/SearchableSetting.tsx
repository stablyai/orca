import { useAppStateValue } from '@/store/app-state-view'
import type React from 'react'
import { cn } from '@/lib/utils'
import { matchesSettingsSearch, type SettingsSearchEntry } from '../search/settings-search'

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
  const query = useAppStateValue((state) => state.settingsSearchQuery)
  if (!forceVisible && !matchesSettingsSearch(query, { title, description, keywords })) {
    return null
  }

  return (
    <div className={cn('scroll-mt-6 w-full max-w-3xl', className)} id={id}>
      {children}
    </div>
  )
}
