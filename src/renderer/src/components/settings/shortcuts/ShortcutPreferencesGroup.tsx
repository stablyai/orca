import React from 'react'
import { useAppStore } from '../../../store/index'
import { useLegacySearchShortcutSnapshot } from '@/lib/keyboard/search-shortcut-offer'
import { matchesSettingsSearch } from '../search/settings-search'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { SearchShortcutOptInControl } from './SearchShortcutOptInControl'
import { ShortcutTerminalPolicyControl } from './ShortcutTerminalPolicyControl'
import {
  getSearchShortcutOptInSearchEntry,
  getTerminalShortcutPolicySearchEntry
} from './shortcuts-search'

export function ShortcutPreferencesGroup({
  searchQuery
}: {
  searchQuery: string
}): React.JSX.Element | null {
  const terminalShortcutPolicy = useAppStore(
    (state) => state.settings?.terminalShortcutPolicy ?? 'orca-first'
  )
  const updateSettings = useAppStore((state) => state.updateSettings)
  const legacySearchSnapshot = useLegacySearchShortcutSnapshot()
  const showPolicy = matchesSettingsSearch(searchQuery, getTerminalShortcutPolicySearchEntry())
  const showSearchShortcut =
    legacySearchSnapshot !== null &&
    matchesSettingsSearch(searchQuery, getSearchShortcutOptInSearchEntry())
  if (!showPolicy && !showSearchShortcut) {
    return null
  }
  return (
    <SettingsGroup>
      {showPolicy ? (
        <ShortcutTerminalPolicyControl
          terminalShortcutPolicy={terminalShortcutPolicy}
          keywords={getTerminalShortcutPolicySearchEntry().keywords}
          updateSettings={updateSettings}
        />
      ) : null}
      {showSearchShortcut ? <SearchShortcutOptInControl snapshot={legacySearchSnapshot} /> : null}
    </SettingsGroup>
  )
}
