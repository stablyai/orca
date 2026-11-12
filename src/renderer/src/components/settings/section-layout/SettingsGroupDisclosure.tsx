import type React from 'react'
import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useAppStore } from '../../../store/index'
import { normalizeSettingsSearchQuery } from '../search/settings-search'
import { useTranslate } from '@/i18n/use-translate'
import { SETTINGS_GROUP_NESTED_INSET_CLASS } from './SettingsGroup'

type SettingsGroupDisclosureProps = {
  label?: string
  forceOpen?: boolean
  children: React.ReactNode
}

/** Collapsible rows inside a SettingsGroup card, one fixed step in from the card's rows. Search force-opens it so matches remain reachable. */
export function SettingsGroupDisclosure({
  label,
  forceOpen = false,
  children
}: SettingsGroupDisclosureProps): React.JSX.Element {
  const t = useTranslate()
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const isSearching = normalizeSettingsSearchQuery(searchQuery).length > 0
  const [open, setOpen] = useState(false)
  const forced = isSearching || forceOpen
  const expanded = open || forced

  return (
    <div data-settings-group-disclosure="" className="border-t border-border">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOpen((prev) => !prev)}
        // Search matches and unsaved edits must remain reachable.
        disabled={forced}
        className="flex min-h-11 w-full items-center gap-2 text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 disabled:cursor-default"
      >
        <ChevronRight
          className={cn(
            'size-3.5 text-muted-foreground transition-transform',
            expanded && 'rotate-90'
          )}
        />
        {label ?? t('auto.components.settings.AppearanceAdvancedDisclosure.advanced', 'Advanced')}
      </button>
      {expanded ? <div className={SETTINGS_GROUP_NESTED_INSET_CLASS}>{children}</div> : null}
    </div>
  )
}
