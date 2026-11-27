import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getLegacySearchBindings } from '../../../../../shared/keybindings/definitions'
import { getLegacyProfileSearchDefaults } from '../../../../../shared/keybindings/search-shortcut-opt-in'
import type {
  KeybindingFileSnapshot,
  KeybindingPlatform,
  SearchShortcutChoice
} from '../../../../../shared/keybindings/types'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { SearchShortcutOptInControl } from './SearchShortcutOptInControl'

function legacyProfile(
  platform: KeybindingPlatform,
  choice: SearchShortcutChoice | null
): KeybindingFileSnapshot {
  const defaults = choice
    ? getLegacyProfileSearchDefaults(platform, choice)
    : getLegacySearchBindings(platform)
  return {
    path: '/preview/keybindings.json',
    platform,
    exists: false,
    overrides: defaults,
    defaultOverrides: defaults,
    commonOverrides: {},
    platformOverrides: {},
    diagnostics: [],
    searchShortcut: { choice }
  }
}

function row(platform: KeybindingPlatform, choice: SearchShortcutChoice | null) {
  return defineFixture({
    width: 640,
    render: () => (
      <SettingsGroup>
        <SearchShortcutOptInControl snapshot={legacyProfile(platform, choice)} />
      </SettingsGroup>
    )
  })
}

export const macUndecided = row('darwin', null)
export const macSwitched = row('darwin', 'accepted')
export const windowsUndecided = row('win32', null)
export const windowsSwitched = row('win32', 'accepted')
